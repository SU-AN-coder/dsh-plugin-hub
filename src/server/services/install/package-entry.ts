/**
 * DSH Plugin Hub — the community plugin marketplace for DeepSeek Harness.
 * Website: https://dsh-plugin.org
 * GitHub: https://github.com/dshplugin/dsh-plugin-hub
 *
 * 分发文件解析：从 package.json 推出装完后必须真实存在的文件 —— 作者声明的入口
 * （exports["."] / main）与 bundle 声明的补丁（dsh.bundle.patch）。git 通道（tar 预检）
 * 与 npm 通道（装后 statSync 校验）共用，保证两条通道对同一个包判定一致。
 *
 * 这里不替作者补一个 index.js：宿主加载一个 bundle 读的是它的 package.json 和它声明的
 * 补丁文件（官方 bundleManifest 的注释即「Read bundle metadata without loading its
 * JavaScript」），从不 import 包本身。凭空要求一个作者没声明的入口，只会把完整的
 * 技能包判成分发残缺，并把一条假缺陷推到作者仓库（见 QingYunA/answer-me-with-html#209）。
 */

/** exports 条件对象里按优先级尝试的键；Node 语义下 default 最宽，import/require 次之。 */
const EXPORT_CONDITION_KEYS = ['default', 'import', 'require'] as const

/** 解析所需的 manifest 字段；其余字段不读。 */
export interface PackageManifest {
  main?: unknown
  exports?: unknown
  dsh?: unknown
}

/**
 * 解析作者声明的入口文件（相对包根，不带 `./` 前缀）。manifest 未声明入口时返回 null：
 * 没有声明就没有可缺失的入口，是否可 import 交给真实安装与宿主加载去暴露。
 *
 * Node 的 exports 规范要求字符串 target 以 `./` 开头（如 `"./lib/index.js"`），
 * 而 tar 成员名与磁盘路径都不带该前缀，因此统一剥掉；条件对象
 * （`{ "import": ..., "require": ... }`）按 default → import → require 取第一
 * 个字符串值。无 exports 时回退 main；两者都没有则没有入口。
 */
export function resolvePackageEntry(meta: PackageManifest): string | null {
  const dot = (meta.exports as Record<string, unknown> | undefined)?.['.']
  const fromExports = typeof dot === 'string'
    ? dot
    : dot !== null && typeof dot === 'object'
      ? firstStringOf(dot as Record<string, unknown>)
      : undefined
  const candidate = typeof fromExports === 'string' ? fromExports
    : typeof meta.main === 'string' ? meta.main
      : null
  return candidate === null ? null : stripDotSlash(candidate)
}

/**
 * 解析 `dsh.bundle.patch` 声明的补丁文件（相对包根，不带 `./` 前缀）。
 * 形状不合规范（既不是字符串也不是字符串数组）在这里不判定：那是 dsh 启动时
 * bundlePatchFiles 的报错职责，预检只负责「声明了就要在包里存在」。
 */
export function resolveBundlePatchFiles(meta: PackageManifest): string[] {
  const patch = (meta.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch
  const declared = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  return declared
    .filter((file): file is string => typeof file === 'string' && file !== '')
    .map(stripDotSlash)
}

/** 分发里必须存在的全部文件：作者声明的入口，加上 bundle 声明的补丁，入口在前。 */
export function requiredDistributionFiles(meta: PackageManifest): string[] {
  const entry = resolvePackageEntry(meta)
  return [...(entry === null ? [] : [entry]), ...resolveBundlePatchFiles(meta)]
}

function firstStringOf(conditions: Record<string, unknown>): string | undefined {
  for (const key of EXPORT_CONDITION_KEYS) {
    const value = conditions[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

const stripDotSlash = (file: string): string => file.replace(/^\.\//u, '')
