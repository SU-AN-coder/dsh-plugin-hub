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
 *
 * 例外是补丁自己 mount 了本包：dsh 的《打包与安装插件》里组合包的常规写法就是
 * `- insert: - name: <本包名>`，宿主随后按包名 import 本包，入口那时必须存在。
 * 所以只有补丁真的写了自己的包名，才把这个入口算进分发要求。
 */

/** exports 条件对象里按优先级尝试的键；Node 语义下 default 最宽，import/require 次之。 */
const EXPORT_CONDITION_KEYS = ['default', 'import', 'require'] as const

/** 解析所需的 manifest 字段；其余字段不读。 */
export interface PackageManifest {
  name?: unknown
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

/** 分发里必须存在的全部文件：作者声明的入口，加上 bundle 声明的补丁，入口在前。
 *  manifest 没声明入口时才看补丁：补丁按本包名 mount 自己（下面 mountsItself），
 *  宿主就会 import 本包，Node 的旧式解析落到 index.js —— 那个入口同样必须有。 */
export function requiredDistributionFiles(meta: PackageManifest, patchTexts: string[] = []): string[] {
  const declared = resolvePackageEntry(meta)
  const entry = declared ?? (mountsItself(meta, patchTexts) ? 'index.js' : null)
  return [...(entry === null ? [] : [entry]), ...resolveBundlePatchFiles(meta)]
}

/**
 * 补丁文本里插件行的 `name:` 值（DSH 补丁按行书写：`- name: <pkg>` / `  name: <pkg>`）。
 * 刻意不做 YAML 解析：只认这一种行形状，认不出来就不判定 —— 漏判只是少一条要求，
 * 误判会拦下能装的包，两边的代价不对称。
 */
export function patchRowNamesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:-\s*)?name:\s*(.+?)\s*$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => value.replace(/^(['"])(.*)\1$/u, '$2'))
    .filter((value) => value !== '')
}

/** 补丁是否把本包自己 mount 进树（dsh 文档里组合包的常规写法），是则宿主会 import 本包。 */
export function mountsItself(meta: PackageManifest, patchTexts: string[]): boolean {
  const name = meta.name
  if (typeof name !== 'string' || name === '') return false
  return patchTexts.some((text) => patchRowNamesOf(text).includes(name))
}

function firstStringOf(conditions: Record<string, unknown>): string | undefined {
  for (const key of EXPORT_CONDITION_KEYS) {
    const value = conditions[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

const stripDotSlash = (file: string): string => file.replace(/^\.\//u, '')
