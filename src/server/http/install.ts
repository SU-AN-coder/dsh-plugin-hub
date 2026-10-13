/**
 * DSH Plugin Hub — the community plugin marketplace for DeepSeek Harness.
 * Website: https://dsh-plugin.org
 * GitHub: https://github.com/dshplugin/dsh-plugin-hub
 *
 * Install/uninstall routes: validate the target and spawn the official dsh CLI
 * (see services/install/install.ts), reporting the captured result back.
 */
import { githubRefOf, githubRepoOf, githubTarget, globalNpmPackagesOf, hasQueuedTarget, installTargetOf, startPluginMutation, validPackageName, type LoaderHandle } from '../services/install/install.ts'
import { githubReleaseTarget } from '../services/install/release-target.ts'
import { recordResolvedNpmPackage } from '../services/profile/installed-versions.ts'
import { isDshNpmPackageForRepo, resolveNpmPackage } from '../services/install/npm-resolve.ts'
import { preflightTarget } from '../services/install/preflight.ts'
import { gitLsRemote, probeUrl, systemProxy } from '../services/probe.ts'
import { loadSettings, type HubSettings } from '../services/settings.ts'
import { installedRepoOf, readInstalled } from './catalog.ts'
import { COMMAND_TIMEOUT_MS, readJsonBody, requireTrustedPost, sendJson, type WebRoute, type WebServerService } from './shared.ts'

/** 安装/卸载 CLI 的子进程环境：透传宿主环境，并按设置注入 HTTP(S) 代理。
 *  不注入 npm registry —— 安装完全沿用用户本机 npm 配置（~/.npmrc / 全局配置）。
 *  代理优先级：设置里的代理 → 系统代理（macOS scutil / Windows 注册表）→ 宿主 env 原有值。
 *  使安装通道与诊断使用相同的代理来源。 */
function mutationEnv(settings: HubSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' }
  const proxy = settings.proxy !== '' ? settings.proxy : (systemProxy() ?? '')
  if (proxy !== '') {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  return env
}

/** Match a GitHub install target against the installed table; returns the package name when already installed. */
function installedByRepo(installed: Record<string, string>, target: string): string | null {
  const repo = githubRepoOf(target)
  if (repo === null) return null
  const needle = repo.toLowerCase()
  for (const [name, spec] of Object.entries(installed)) {
    if (githubRepoOf(spec)?.toLowerCase() === needle) return name
  }
  return null
}

export function registerInstallRoutes(webServer: WebServerService, profile: string, loader: LoaderHandle | undefined): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: '/dsh-plugin-hub/install',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        // 任务自动入队：即使已有插件操作在跑也接受请求（FIFO 串行执行），不做 409 拒绝
        try {
          const body = await readJsonBody(request)
          // mode: 'update' = 已安装目标的覆盖更新（放行 add，pnpm 对已存在依赖原位覆盖重装）。
          // 后续「同仓库残留」检测可能把 install 就地升级为 update（见包名冲突检测），故用 let。
          let mode = body !== null && typeof body === 'object' && (body as { mode?: unknown }).mode === 'update'
            ? 'update'
            : 'install'
          // installTargetOf 先把完整 DSH 命令（`dsh plugin [--profile <p>] add <target>`）剥成裸目标，
          // 兼容用户直接粘贴命令行（防输错），真正语法判定交给下面 githubRepoOf / validPackageName。
          const rawRepo = typeof body === 'object' && body !== null && typeof (body as { repo?: unknown }).repo === 'string'
            ? installTargetOf((body as { repo: string }).repo)
            : ''
          // 前端决策的展示用仓库名（owner/repo）：npm 安装时 body.repo 是包名，display 用于
          // 待重启行 / 任务恢复时展示仓库名，保证用户无感知（安装通道变化不改变所见目标）
          const displayRepo = typeof body === 'object' && body !== null && typeof (body as { display?: unknown }).display === 'string'
            ? (body as { display: string }).display.trim()
            : rawRepo
          // 请求来源：目录插件安装（catalog）走目录白名单；命令行安装（custom）按通道受安全开关控制
          const source = typeof body === 'object' && body !== null && typeof (body as { source?: unknown }).source === 'string'
            ? (body as { source: string }).source
            : ''
          // 自定义安装入口渠道（客户端三张卡片：NPM 包 / GitHub 源码 / DSH 命令）：
          // 客户端显式上报，服务端日志/报错据此精准溯源「从哪个入口发起」；目录插件安装不传。
          const installChannel = (() => {
            const raw = body !== null && typeof body === 'object' ? (body as { installChannel?: unknown }).installChannel : undefined
            return raw === 'git' || raw === 'dsh' || raw === 'npm' ? raw : undefined
          })()
          const settings = loadSettings(profile)
          // 界面语言（客户端随请求携带）：错误消息按用户当前语言提示（中文界面给中文，英文界面给英文）
          const lang = typeof body === 'object' && body !== null && (body as { lang?: unknown }).lang === 'en'
            ? 'en'
            : 'zh'
          // 全局 npm 安装（官方 README 的 `npm install -g <pkgs>`，如 dsh-tui 的安装命令）：
          // 直接从命令框输入格式执行全局安装，不进任何 profile、无需宿主重启。
          // 包列表优先取 body.globalNpm（客户端命令框解析后显式携带）；兜底再从 rawRepo 解析，
          // 保证直接调 API 传完整命令也能识别。
          const bodyGlobalNpm = Array.isArray((body as { globalNpm?: unknown }).globalNpm)
            ? (body as { globalNpm: unknown[] }).globalNpm.filter((x): x is string => typeof x === 'string' && x !== '')
            : []
          let globalNpm: string[] = bodyGlobalNpm.length > 0 ? bodyGlobalNpm : (globalNpmPackagesOf(rawRepo) ?? [])
          if (globalNpm.length > 0) {
            // 包名逐个按 npm 包名语法校验 + 拒绝以 - 开头的 token（npm 会把 --xxx 当参数而非包名），数量封顶防滥用
            if (globalNpm.length > 20 || globalNpm.some((p) => !validPackageName(p) || p.startsWith('-'))) {
              sendJson(response, 400, { error: 'unsupported install target' })
              return
            }
            // 通道门禁与安装通道同构：全局安装本质是 npm 操作，吃「启用 NPM 安装」开关
            if (source !== 'catalog' && !settings.enableNpmInstall) {
              sendJson(response, 403, { error: 'npm installs are disabled by the security settings' })
              return
            }
            // 队列级去重：同一包列表已在排队/执行中时拒绝
            const identity = globalNpm.join(' ')
            if (hasQueuedTarget(identity)) {
              sendJson(response, 409, { error: `already queued: ${identity}` })
              return
            }
            const task = startPluginMutation({
              action: 'add',
              profile,
              target: identity,
              displayTarget: identity,
              globalNpm,
              timeoutMs: COMMAND_TIMEOUT_MS,
              env: mutationEnv(settings),
              // 全局 npm 安装由 NPM 包卡片/官方命令发起：日志体现入口渠道
              installChannel: installChannel ?? 'npm',
            })
            sendJson(response, 200, { ok: true, task: task.id })
            return
          }
          // 目标语法三态：固定 GitHub release .tgz（保留其包根目录，不转成仓库 HEAD）；
          // GitHub 地址（owner/repo、github:、https/ssh 链接等任意写法）→ 显式 HTTPS Git 源
          // （走装前预检）；npm 包名（@scope/name 或 name）→ 信任 registry 直接安装。
          // githubRepoOf 先把各种 GitHub 地址归一成 owner/repo，让「输入地址即装」兼容粘贴完整链接。
          const gitRepo = githubRepoOf(rawRepo)
          const release = githubReleaseTarget(rawRepo)
          // 显式 pin 的 Git ref（`#tag` / `#commit`）是用户意图：保留它，且不让 npm 反查
          // 把这个精确修订换成 registry 上的默认版本。
          const pinnedRef = githubRefOf(rawRepo)
          const repoTarget = gitRepo !== null && release === null ? githubTarget(gitRepo, pinnedRef) : null
          let target: string | null = release?.target ?? repoTarget ?? (validPackageName(rawRepo) ? rawRepo : null)
          if (target === null) {
            sendJson(response, 400, { error: 'unsupported install target' })
            return
          }
          const attempts: string[] = []
          // 代理口径与诊断/安装通道一致：设置里的代理 → 系统代理 → 环境变量 → 直连。
          // 供 npm 反查时跟随 GitHub 改名跳转用（Node https 读不到系统代理，交给 curl）。
          const effectiveProxy = settings.proxy !== ''
            ? settings.proxy
            : (systemProxy() ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '')
          // Catalog metadata may outlive a packaging split: one repository can publish both a
          // CLI/helper package and a dedicated DSH plugin package. Keep the catalog target when
          // registry metadata confirms it is a DSH package for this repo. Otherwise inspect the
          // repository root package.json and use its package name only when that exact registry
          // package also points back to the repo and identifies as a DSH plugin. This avoids
          // relying on npm search ranking, which is not a repository index and can omit the
          // correct package even with a large result window.
          const catalogRepo = source === 'catalog' ? githubRepoOf(displayRepo) : null
          if (catalogRepo !== null && release === null && repoTarget === null && validPackageName(rawRepo)) {
            const catalogTargetIsDsh = await isDshNpmPackageForRepo(rawRepo, catalogRepo, settings.npmRegistry, effectiveProxy)
            if (catalogTargetIsDsh) {
              recordResolvedNpmPackage(profile, catalogRepo, rawRepo)
            } else {
              const catalogGitTarget = githubTarget(catalogRepo)
              if (catalogGitTarget !== null) {
                const root = await preflightTarget(catalogGitTarget)
                const rootName = root.ok && root.name !== null && validPackageName(root.name) ? root.name : null
                if (rootName !== null && rootName !== rawRepo
                    && await isDshNpmPackageForRepo(rootName, catalogRepo, settings.npmRegistry, effectiveProxy)) {
                  attempts.push(`catalog npm target: \`${target}\` → repository root DSH package \`${rootName}\``)
                  target = rootName
                  recordResolvedNpmPackage(profile, catalogRepo, rootName)
                }
              }
            }
          }
          // npm 优先：git 目标先反查该仓库的官方 npm 包，命中则改走 npm 通道。
          // git 分发常缺构建产物/子模块，npm 包是作者发布的完整产物；未命中或
          // 查询失败保留 github 直装（不阻塞安装，预检仍会拦截缺入口文件的情况）。
          // 通用机制，不针对具体插件。
          // 反查本身计入「已尝试的安装方式」：组织 scope 与 GitHub 用户名不一致时仅凭
          // 仓库名猜不到包名，失败提 Issue 时作者看到我们查过的命令就能直接指认正确包名。
          // 显式 pin 了 Git ref 时跳过 npm 反查：用户要的就是那个精确修订，
          // 不能用 registry 上的默认版本覆盖它。
          if (repoTarget !== null && pinnedRef === null) {
            // 反查/记录统一用归一化后的 owner/repo（gitRepo），保证「输入完整链接」也走同一套 npm 反查
            const repoIdentity = gitRepo ?? rawRepo
            const npmName = await resolveNpmPackage(repoIdentity, settings.npmRegistry, effectiveProxy)
            if (npmName !== null) {
              target = npmName
              attempts.push(`npm registry search: \`npm search repository:${repoIdentity}\` → found \`${npmName}\``)
              // 持久化 repo → npm 包名映射：目录数据未下发 npmPackage（组织 scope 与 GitHub
              // 用户名不一致）时，客户端仍能通过 /installed 的 versions 把依赖 key 匹配回仓库，
              // 列表立即显示「已安装」，避免安装成功后仍显示可安装
              recordResolvedNpmPackage(profile, repoIdentity, npmName)
            } else {
              attempts.push(`npm registry search: \`npm search repository:${repoIdentity}\` → no matching package found (falling back to git install)`)
            }
          }
          // 命令行安装（目录外）按通道门禁：GitHub 源码通道受「启用 GitHub 源码安装」控制，
          // npm 通道受「启用 NPM 安装」控制 —— 目录插件安装走目录白名单，不受开关影响。
          // 通道判定看反查后的最终 target：release 包与 git 目标同属 GitHub 通道，否则走 npm。
          if (source !== 'catalog') {
            const isGitChannel = release !== null || (repoTarget !== null && target === repoTarget)
            if (isGitChannel && !settings.enableGitInstall) {
              sendJson(response, 403, { error: 'git installs are disabled by the security settings' })
              return
            }
            if (!isGitChannel && !settings.enableNpmInstall) {
              sendJson(response, 403, { error: 'npm installs are disabled by the security settings' })
              return
            }
          }
          // 重复安装防护：非更新请求命中已安装目标时直接拒绝，不重复跑 CLI
          // （否则 CLI 会因「已存在」失败，且用户看到的是莫名其妙的报错）；
          // 更新请求（mode: 'update'）放行，CLI 的 add 对已存在依赖是 pnpm 原位覆盖重装。
          // 命中判定双通道：npm 包名按 dependencies 键直接命中，GitHub 目标按仓库身份匹配。
          const installed = readInstalled(profile)
          const already = installedByRepo(installed, target) ?? (installed[target] !== undefined ? target : null)
          if (already !== null && mode !== 'update') {
            sendJson(response, 409, { error: `already installed: ${already}` })
            return
          }
          // 队列级去重：同一目标已在排队/执行中时拒绝，避免客户端防重竞态导致重复入队
          if (hasQueuedTarget(target)) {
            sendJson(response, 409, { error: `already queued: ${target}` })
            return
          }
          // 安装前网络连通性预检：npm 通道探 registry、git 通道探 github.com 连通性。
          // 探测目标固定为通道的稳定入口（registry 根 / github.com 主页），不探具体包或仓库
          // 页 —— 404 表示「目标不存在」而非网络不通，不该被当成网络故障拦截。
          // 仅新安装预检（更新是已信任目标的覆盖重装，跳过）；不通直接 400 拦下并打
          // [network] 标记，客户端据此提示「你的网络不通」，而不是把网络失败当成
          // 插件侧问题引导去作者仓库提 Issue。
          // 代理口径与诊断一致：设置里的代理 → 系统代理 → 环境变量 → 直连。
          if (already === null) {
            const isGitChannel = release !== null || (repoTarget !== null && target === repoTarget)
            // release 包是 https://github.com/ 直链下载（非 git 克隆），探针按 HTTP 打 github.com 主页；
            // npm 通道探 registry 根。两者都是通道的稳定入口，不探具体包/仓库（404 会被误判成网络故障）。
            const httpProbeTarget = release !== null
              ? 'https://github.com/'
              : `${(settings.npmRegistry.replace(/\/+$/, '') || 'https://registry.npmjs.org')}/`
            // git 通道的探针换成克隆握手本身：git ls-remote 走的就是 pnpm 克隆前的同一套
            // https 传输。curl 打 github.com 主页会被按协议/端口区分的防火墙与 TLS 复检
            // 拦截（能 git 克隆、打不开网页），把可装的仓库误判成 [network] 而中止。
            // 握手失败时再用 curl 复核一次主页连通性：只有两者都不通
            // 才判「网络不通」；仅握手失败（仓库不存在、私有仓库、需要凭据）放行，
            // 交给后续预检与真实安装给出准确原因。
            // 探针只握手仓库本身（去掉 git+ 前缀与 #ref 片段）：ls-remote 认的是仓库地址，
            // 带 ref 片段会干扰 URL 解析
            const gitProbeTarget = repoTarget === null ? null : repoTarget.replace(/^git\+/, '').replace(/#.*$/, '')
            let net: Awaited<ReturnType<typeof probeUrl>>
            if (gitProbeTarget !== null) {
              net = await gitLsRemote(gitProbeTarget, effectiveProxy, 6000)
              if (!net.ok) {
                const reachable = await probeUrl('https://github.com/', effectiveProxy, 6000)
                if (reachable.ok) net = reachable
              }
            } else {
              net = await probeUrl(httpProbeTarget, effectiveProxy, 6000)
            }
            const probeTarget = gitProbeTarget ?? httpProbeTarget
            if (!net.ok) {
              // 错误消息按客户端界面语言提示：中文界面给中文、英文界面给英文，
              // 让用户一眼看懂是网络问题而非插件问题
              const channelName = isGitChannel
                ? (lang === 'zh' ? 'GitHub' : 'github.com')
                : (lang === 'zh' ? 'npm 源' : 'the npm registry')
              const error = lang === 'zh'
                ? `[network] 安装已中止：安装前无法连接到 ${channelName}（${probeTarget}）—— 您的网络似乎不通或被拦截（断网 / DNS 解析失败 / 防火墙 / 代理配置问题）。这不是插件本身的问题，请检查网络连接或代理设置，运行「系统诊断」检测各通道连通性后重试。`
                : `[network] install aborted: cannot reach ${channelName} (${probeTarget}) before install — your network connection appears to be down or blocked (DNS / proxy / firewall). This is not a problem with the plugin itself. Check your connection or proxy settings, run the connectivity diagnostic, then retry.`
              sendJson(response, 400, { error, attempts })
              return
            }
          }
          // 安装前预检：仅新安装走预检（github 源分发缺 package.json 声明的文件时直接拦截）。
          // 更新是已信任目标的覆盖重装，跳过预检避免重复下载 tarball。
          // npm 包信任 registry 直接放行；github 源拦截时标记 [packaging] 前缀，
          // 供客户端归类为「插件分发不完整」并引导去仓库提 Issue
          if (already === null) {
            const preflight = await preflightTarget(target)
            if (!preflight.ok) {
              // 预检拦截（git 分发缺作者声明的文件）：同步 400 返回，附上已尝试的安装方式，
              // 客户端失败弹窗提 Issue 时一并贴给作者
              sendJson(response, 400, {
                error: `[packaging] ${target}: plugin distribution is incomplete — the file ${preflight.missing ?? '?'} the package needs (its declared entry, an entry a bundled patch mounts, or the patch itself) is not present in the git distribution (build output not committed). Report to the author.`,
                attempts,
              })
              return
            }
            // 包名冲突检测（仅 git 通道）：git 目标包内声明的 name 若与 profile 已装依赖同名，
            // pnpm 会以该 name 做依赖键撞车，抛出的 CLI 报错晦涩难懂 —— 且该包名在 registry 上
            // 可能被别的仓库占用，npm 反查搜不到，git 直装就会撞上已装的同名依赖。
            // 到这里已装依赖要么来源不同仓库、要么 spec 是版本号解析不出仓库身份。
            // 读 node_modules 里已装包的真实 repository 区分两种情况：
            //  - 指向同一仓库 → 是「同仓库残留」（spec 丢了仓库身份），就地转 update 覆盖重装（幂等）；
            //  - 指向别的仓库 / 读不到 → 跨仓库包名冲突，入队前转成明确 409，指导用户先卸载或改装。
            if (preflight.name !== null && repoTarget !== null && target === repoTarget) {
              const declared = preflight.name
              if (installed[declared] !== undefined) {
                const installedRepo = installedRepoOf(profile, declared)
                if (installedRepo !== null && gitRepo !== null && installedRepo.toLowerCase() === gitRepo.toLowerCase()) {
                  // 同名且同源：已装 spec 丢了仓库身份导致的残留，直接按 update 覆盖重装，不打扰用户
                  attempts.push(`same-repo residual: \`${declared}\` resolves to \`${installedRepo}\` → reinstall as update`)
                  mode = 'update'
                } else {
                  attempts.push(`package name conflict: \`${gitRepo}\` declares npm name \`${declared}\`, which is already present in the profile and cannot be matched to this repo (that npm name is likely registered by another repository)`)
                  const error = lang === 'zh'
                    ? `already installed: ${declared} —— ${gitRepo} 声明的 npm 包名「${declared}」已存在于当前 profile，且无法匹配到本仓库（该包名在 npm 上可能被其他仓库占用）。请先移除现有的 ${declared}（dsh plugin remove ${declared}），再重新安装；或改装该包名对应的官方 npm 包。`
                    : `already installed: ${declared} — ${gitRepo} declares the npm package name "${declared}", which is already present in the profile and cannot be matched to this repo (that npm name is likely registered by another repository). Remove the existing ${declared} dependency (dsh plugin remove ${declared}) first, then retry; or install the official npm package under that name.`
                  sendJson(response, 409, { error, attempts })
                  return
                }
              }
            }
          }
          // 入队前复检（与上方检查同语义，但必须在同步块内）：preflight 的 await 期间并发请求
          // 可能已通过上方检查、任务却尚未入队——此处检查与 startPluginMutation 之间无 await，
          // JS 单线程保证同一目标至多一个任务，杜绝双击/并发产生双任务
          if (hasQueuedTarget(target)) {
            sendJson(response, 409, { error: `already queued: ${target}` })
            return
          }
          // Kick off the CLI in the background; the client polls /status for progress
          const task = startPluginMutation({
            // mode=update（已安装目标的覆盖更新）以 update 动作入队：
            // 日志按 update 类别落盘（update.start/done/fail），实际 CLI 执行仍是 add <target>@latest
            action: mode === 'update' ? 'update' : 'add',
            profile,
            target,
            // npm 安装时 target 是包名：displayTarget 固定展示仓库名，待重启行/前端恢复不受通道变化影响
            displayTarget: githubRepoOf(displayRepo) ?? undefined,
            // 已尝试的安装方式（npm 反查）：实际执行命令由 spawn 时追加，失败 issue 一并展示
            attempts,
            timeoutMs: COMMAND_TIMEOUT_MS,
            env: mutationEnv(settings),
            // 覆盖更新：npm 通道命令显式 @latest（pnpm add 无版本对已存在依赖是幂等的，不加版本不会真更新）
            updateNpm: mode === 'update',
            // 运行中 loader：安装成功后把新插件热挂进 loader，非桌面端 + 纯服务端插件无需重启即生效
            loader,
            // 自定义安装入口渠道（NPM 包 / GitHub 源码 / DSH 命令卡片）：日志/报错据此溯源
            installChannel,
          })
          sendJson(response, 200, { ok: true, task: task.id })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-plugin-hub/uninstall',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        // 与安装一致：卸载也进入同一队列，FIFO 串行执行
        try {
          const body = await readJsonBody(request)
          const name = typeof body === 'object' && body !== null && typeof (body as { name?: unknown }).name === 'string'
            ? (body as { name: string }).name
            : ''
          // 展示用的 owner/repo：卸载命令只需要 npm 包名，但待重启行要与安装行一致地显示仓库名
          const repo = typeof body === 'object' && body !== null && typeof (body as { repo?: unknown }).repo === 'string'
            ? (body as { repo: string }).repo
            : ''
          if (!validPackageName(name) || name === 'dsh-plugin') {
            sendJson(response, 400, { error: 'plugin cannot be uninstalled here' })
            return
          }
          if (readInstalled(profile)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          // 队列级去重：同一包已在排队/执行中卸载时拒绝
          if (hasQueuedTarget(name)) {
            sendJson(response, 409, { error: `already queued: ${name}` })
            return
          }
          const task = startPluginMutation({
            action: 'remove',
            profile,
            target: name,
            // 卸载的 mutation 目标是 npm 包名；待重启行要显示 owner/repo（与安装行一致），非法/缺失时回退包名
            displayTarget: githubRepoOf(repo) ?? undefined,
            // 运行中 loader：卸载成功后主动移除条目，立即生效、无需重启
            loader,
            timeoutMs: COMMAND_TIMEOUT_MS,
            env: mutationEnv(loadSettings(profile)),
          })
          sendJson(response, 200, { ok: true, task: task.id })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
