/**
 * DSH Plugin Hub — the community plugin marketplace for DeepSeek Harness.
 * Website: https://dsh-plugin.org
 * GitHub: https://github.com/dshplugin/dsh-plugin-hub
 *
 * 安装前预检：对 GitHub 源的插件，检查其分发（codeload tarball）里是否真的包含
 * package.json 声明的文件（main / exports["."] / dsh.bundle.patch）。git 分发常不提交
 * 构建产物（lib/ 等），这类残缺包装完会让宿主重启加载插件树时 ERR_MODULE_NOT_FOUND
 * 直接崩溃 —— 预检在动手安装前就把它们拦下，避免白装一次。
 * npm 包信任 registry 的完整性，直接放行；任何无法预检的情况也放行，交给装后
 * 校验（verifyInstalledEntry）兜底，保证预检自身失败不会卡死安装流程。
 */
import { execFile } from 'node:child_process'
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { githubRefOf, githubRepoOf } from '../profile/profile.ts'
import { githubReleaseTarget } from './release-target.ts'
import { requiredDistributionFiles, resolveBundlePatchFiles } from './package-entry.ts'

const execFileAsync = promisify(execFile)

/** 单次网络操作超时（ms）：git ls-remote / codeload 下载。网络不可达时不能无限挂起，
 *  否则 `/install` 请求永远不返回、任务不入队、前端进度卡 0%。超时后放行（交给装后校验）。 */
const PREFLIGHT_TIMEOUT_MS = 15_000

/** 预检结果：ok=false 表示分发改 package.json 声明的文件（入口或 bundle 补丁），
 *  missing 为该文件在包内的相对路径；
 *  name 为 git 分发包 package.json 声明的包名（非 git 目标/无法确定时为 null），
 *  供安装路由做「包名冲突」检测 —— 同名包名已被其他来源占用时，pnpm 装前必然撞车，
 *  需要把晦涩的 CLI 报错转成明确的拦截。 */
export interface PreflightResult {
  ok: boolean
  missing: string | null
  name: string | null
}

export async function preflightTarget(target: string): Promise<PreflightResult> {
  // release 包自带包根：拿 monorepo HEAD 的源码分发去校验它没有意义，会把完整产物
  // 误判成缺入口文件而拦下。该包的真实性交给安装本身与装后 verifyInstalledEntry 兜底。
  if (githubReleaseTarget(target) !== null) return { ok: true, missing: null, name: null }
  const source = githubRepoOf(target)
  if (source === null) return { ok: true, missing: null, name: null }
  const [owner, repo] = source.split('/')
  // 显式 pin 的 Git ref 要在它自己的修订上预检：默认分支常是 monorepo 根，与 pin 的发布包
  // 形态不同，拿 HEAD 校验会把完整产物误判成缺入口文件（或反之）。无 pin 时仍查 HEAD。
  const commit = await remoteCommit(owner, repo, githubRefOf(target))
  if (commit === null) return { ok: true, missing: null, name: null }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preflight-'))
  try {
    const tar = join(dir, 'pkg.tar.gz')
    await download(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`, tar)
    const rootPackage = await rootPackageEntry(tar)
    if (rootPackage === null) return { ok: true, missing: null, name: null }
    const rootPrefix = rootPackage.slice(0, -'package.json'.length)
    const meta = await readTarJson(tar, rootPackage)
    if (meta === null) return { ok: true, missing: null, name: null }
    // 只校验作者声明过的文件：没声明入口的包（只挂技能的 bundle）没有可缺失的入口，
    // 它的分发是否完整由 dsh.bundle.patch 是否在包里决定；补丁若按本包名 mount 自己，
    // 入口又变成必须的（宿主会 import 本包）—— 所以判入口前先把补丁读出来。
    const patchTexts: string[] = []
    for (const file of resolveBundlePatchFiles(meta)) {
      const text = await readTarText(tar, `${rootPrefix}${file}`)
      if (text !== null) patchTexts.push(text)
    }
    const required = requiredDistributionFiles(meta, patchTexts).map((file) => `${rootPrefix}${file}`)
    const missing = missingDistributionFileOfTarList(await tarListing(tar), required)
    return { ok: missing === null, missing, name: typeof meta.name === 'string' ? meta.name : null }
  } catch {
    return { ok: true, missing: null, name: null }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Resolve the commit to inspect: the pinned `ref` when given, otherwise the
 * repository default branch (`HEAD`). A full commit SHA passes through as-is;
 * annotated tags are peeled to their commit. Any git/network failure returns
 * null and the caller falls back to "no preflight".
 */
async function remoteCommit(owner: string, repo: string, ref: string | null): Promise<string | null> {
  if (ref !== null && /^[0-9a-f]{40}$/i.test(ref)) return ref
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', `https://github.com/${owner}/${repo}.git`, ref ?? 'HEAD'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const lines = stdout.split(/\r?\n/).filter((line) => line !== '')
    // Annotated tags list the tag object and the peeled commit (`<ref>^{}`): prefer the peel.
    const chosen = lines.find((line) => line.endsWith('^{}')) ?? lines[lines.length - 1]
    return chosen?.split(/\s+/)[0] ?? null
  } catch {
    return null
  }
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: PREFLIGHT_TIMEOUT_MS }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        res.resume()
        if (res.headers.location) {
          void download(res.headers.location, dest).then(resolve, reject)
          return
        }
        reject(new Error('download failed: redirect without location'))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed: HTTP ${res.statusCode ?? '?'}`))
        return
      }
      void pipeline(res, createWriteStream(dest)).then(resolve, reject)
    })
    // 网络不可达时 connect/响应可能无限挂起：超时销毁，避免预检卡死（放行交给装后校验）
    req.on('timeout', () => req.destroy(new Error(`download timeout after ${PREFLIGHT_TIMEOUT_MS}ms`)))
    req.on('error', reject)
  })
}

/** GitHub codeload tarballs use a dynamic top-level directory (`repo-<sha>/`),
 * not npm's `package/` prefix. Pick only a package.json directly under that
 * single archive root; nested monorepo package manifests are intentionally
 * ignored. Exported for a small parser regression test. */
export function rootPackageEntryOfTarList(listing: string): string | null {
  const candidates = listing
    .split(/\r?\n/)
    .filter((line) => /^[^/]+\/package\.json$/u.test(line))
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * 清单里第一个缺失的必需文件（成员名带包根前缀，由调用方拼好），全部都在则为 null。
 * 清单不可读（tar 缺失/解压失败）时按第一个必需文件缺失处理：与逐文件查询时
 * 「查不到就是缺」的判定一致，宁可拦下一次可疑安装，也不放一个空包过去。
 * Exported for a small parser regression test.
 */
export function missingDistributionFileOfTarList(listing: string | null, required: string[]): string | null {
  if (required.length === 0) return null
  if (listing === null) return required[0]
  const present = new Set(listing.split(/\r?\n/))
  return required.find((file) => !present.has(file)) ?? null
}

async function rootPackageEntry(tar: string): Promise<string | null> {
  const listing = await tarListing(tar)
  return listing === null ? null : rootPackageEntryOfTarList(listing)
}

/** tar 成员清单；`tar` 执行失败时返回 null（调用方按无法判定处理）。 */
async function tarListing(tar: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tar', ['-tzf', tar], { maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/** 从 tarball 提取一个文件的内容；文件不存在或提取失败返回 null。 */
async function readTarText(tar: string, entry: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tar', ['-xzOf', tar, entry], { maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/** 从 tarball 提取并解析一个 JSON 文件；文件不存在或解析失败返回 null。 */
async function readTarJson(tar: string, entry: string): Promise<Record<string, unknown> | null> {
  const text = await readTarText(tar, entry)
  if (text === null) return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
