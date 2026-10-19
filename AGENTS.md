# AGENTS.md

dsh-tui-secret 是 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的凭据插件：一个
`/secrets` 全屏场景（自绘掩码输入、引用列表、授权与撤销）加**两个 model-facing 工具** ——
`request_credential`（agent 发起、人在卡片上给值、只回状态）与 `use_credential`（值只进那次
执行的子进程、输出里出现值即脱敏）。值只经 DSH 的凭据接缝写入，插件本体不回显、不记日志、
不进会话。改动前先读
[README_ZH.md](README_ZH.md)（用户视角）与 [docs/plugin-design.md](docs/plugin-design.md)
（设计依据、威胁模型与实测事实）；插件契约与接缝的权威文本在
[上游插件准入与开发指南](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/tui-profile/docs/plugin-admission-and-development.md)。

## 仓库布局

```
src/index.ts          Cordis 插件入口：name / apply、/secrets 场景、打开它的命令
src/store.ts          引用记录（名字 + 授权）与审计：$DSH_TUI_HOME/dsh-tui-secret/{refs.json,audit.jsonl}
src/card.ts           卡片通道：pending + Promise + 场景重绘通知（一次只服务一张卡）
src/use.ts            argv 引号拼装、走 ctx.shell 跑一次、输出脱敏
tsconfig.json        tsc 配置：src/ → lib/types/（`declaration`，不带 declarationMap）
scripts/verify.mjs   验收脚本（npm test）：场景哨兵 + 引号/shell 边界 + 两个工具与权限表
scripts/clean-lib.mjs 编译前清 lib/（tsc 不会删已删源文件的产物）
docs/                根 README 之外的文档；中文无后缀，英文 .en.md
cordis.patch.yml     profile 组合用的包级覆盖层；本包只有一行插件
dsh-plugin.json      插件声明（contracts / contributes / permissions）
```

**`src/` 是真源，`lib/types/` 是 `tsc` 的产物**（与上游 dsh-TUI 同一形状）：`lib/` 不进 git
（见 `.gitignore`），改代码只改 `src/`，改完 `pnpm install`（首次）→ `npm run compile` 重新
生成；`npm test` 会先编译再验（`pretest`）。手写的 `index.d.ts` 没有了 —— 包的类型面由 `tsc`
从 `src/index.ts` 生成，`@internal` 的测试入口用 `stripInternal` 剔除。

完整仓库地图、设计依据与实测事实见 [docs/plugin-design.md](docs/plugin-design.md)；
文档索引见 [docs/README.md](docs/README.md)。

## 命令

```sh
pnpm install    # 首次：装构建依赖（typescript / @types/node / @deepseek-ai/cordis）
npm run compile # = 清 lib/ 再 tsc -p tsconfig.json：src/ → lib/types/
npm test        # 先编译再验：①–⑫ 场景 + ⑬–⑮ 引号/shell + ㉑–㊵ 工具与权限表 + ⑳ 声明闸门，35/35 PASS 为通过
npm run verify  # 同一入口
npm run typecheck   # tsc --noEmit，静态关口
npm pack --dry-run          # 检查发布内容（17 文件；npm 缓存不在工作区时加 npm_config_cache=<目录>）
dsh plugin --profile dsh-tui add <本仓路径>   # 本地试装（会动 profile，先问维护者）
```

仓库**没有** lint 或根级测试框架：静态关口是 `npm run typecheck` 与 `node --check`，行为验证就是
`scripts/verify.mjs`。脚本里用宿主真件的地方（真 React 19 + ink 渲染、`@dsh-std/manifest`
解析器与 TUI profile 校验器）在缺件时打印 `SKIP`，`SKIP` 不算失败，但**不要**把 `SKIP`
当通过报出去。

**本仓从 0.2.0 起不再是「零依赖、无构建」**：克隆下来要联网 `pnpm install`，`lib/` 不进 git，
测试与 `npm pack` 跑的都是编译产物（`package.json` 的 `pretest` / `prepare` 负责编译）。
运行期依赖仍然为零：`ctx.credentials` / `ctx.tuiScenes` / `ctx.shell` / `ctx.tools` 都是宿主的。

## 上游边界与契约

- 只消费公开面：dsh-TUI 的 `ctx.tuiScenes` / `ctx.commands`，DSH 的 `ctx.credentials` /
  `ctx.shell` / `ctx.tools`。官方源码不改，行为差异落配置层或本包。
- **不注册 `shellEnv` 贡献者**：值不进会话环境。唯一持有它的是 `use_credential` 为那一次调用
  拉起的子进程（变量名 `DSH_SECRET_<REF>`，由 `ctx.shell` 的 `spec.env` 传下去，`dshEnv` 不用）。
- 场景面缺席时静默降级（什么都不注册），绝不拖垮 TUI 启动；接入面存在但用错时（如
  `open()` 返回 false）要**响亮报错**，不静默。
- **场景在首次使用时注册，不在 `inject` 回调里碰宿主面**：dsh-TUI 只接受「**当前正在执行的那个
  激活**」发出的 service 调用（`host-access.js` 的 `runActivation` 给环境挂激活令牌，别的激活来调
  一律按 stale activation 拒，最终报 `requires a live Cordis activation context`），而 `ctx.inject`
  的回调跑在它新建的**子激活**下 —— 在回调里用**父** ctx 注册必抛（真机 harness 实测）；改用子
  激活的服务能过，但归属记成子激活，我们打开它时被 `scenes.js` 的 `openScene` 拒（「belongs to
  another activation」）。`apply` 期注册其实合法（LOADING 也放行），但我们仍选惰性注册：命令与
  卡片本来就在自己的激活上（`ensureScene` / `openScene`）。断言在 `⑨`／`㉜`。
- 可选的宿主面一律 `ctx.get(name, false)` 软探测，不放进 `inject` 列表。
- 调试只走 `DSH_TUI_SECRET_DEBUG=1`：`request_credential` 的拒绝 note 附上原因码（不含值）；
  默认措辞不变，不把「人拒绝」与「卡片弹不出来」的差异暴露成可探测的侧信道。

## 约定与红线

- **红线三句**（只写我们守得住的）：① 值不经过两个工具的结果（只回状态／exit code 与
  脱敏输出）；② 值不进我们渲染的屏幕、不进我们的日志与审计文件；③ agent 侧只有这两个
  入口 —— 凡走 agent 这条路的，都从这里过。
- **值只在两处出现**：`ctx.credentials`（写入与读取）与 `use_credential` 为**那一次调用**拉起的
  子进程环境。父进程环境、会话环境、state、日志、错误文本、审计一律不得出现值。
- **不做假承诺**：脱敏只覆盖那一次执行的返回片段；凭据库是明文、沙箱只限写 —— 这些必须写在
  README 的「已知限制」里，卡片文案也不许暗示「存进去模型就拿不到」。
- **fail-closed**：任何前提缺失（空值、非法名、保留前缀、被进程环境遮蔽、没有授权、窗口过期、
  场景面缺席、取不到值、shell 面缺失）都拒绝，不猜、不静默降级；**拒绝路径不写任何字节**。
- **`lib/` 是产物**：源代码只在 `src/`，绝不手改 `lib/types/` 下任何文件；改完跑
  `npm run compile`（或 `npm test`，它会先编译），提交前确认 `npm run typecheck` 干净。
- **文本语言**：源码注释、用户可见的界面与工具文案、测试标签一律英文（与上游默认一致）；
  `README.md` 英文为底、`README_ZH.md` 中文镜像；`docs/` 中文无后缀、英文用 `.en.md`。
- **提交信息**：英文 conventional commits，带 scope，例：`docs(style): align all text with the
  dsh-TUI conventions`。一个提交只做一件事，正文写清「改了什么、为什么、怎么验的」。
- **脱敏**：仓库内容不得出现私用域名、本机绝对路径、凭据或其片段。
- **Git 安全**：只暂存显式路径，不用 `git add .`/`git add -A`；未经要求不 commit、不打 tag、
  不 push。推送权归维护者。
- **`dsh-plugin.json` 必须能过上游 parser**：community v0.15 的 schema 顶层
  `additionalProperties: false`，未知字段直接拒绝（`description` 就不合法，得写成 `x-description`），
  且 `subscriptions` 是必填。改完拿宿主那份 `@dsh-std/manifest` 真跑一遍
  （`parseManifest` + `projectManifest`），别凭印象。
- 改动工具或场景语义时，同步更新 `scripts/verify.mjs`（它是这些面的唯一回归网）与两份 README
  的开发/限制段。
- **manifest 不声明工具**：宿主 registry 里没有 `tools.dsh` 协议组，写了会被校验器判负；
  两个工具一律运行期 `ctx.tools.register`（名字唯一、不占保留名 `run_code`、必填
  `output{schema,render}`）。权限面也不新增（每条权限都要对应已声明的 capability）。

## 代码审查原则

审查改动时，以**不引入新 Bug、最小必要改动、保持代码简洁**为核心原则：

1. **防止回归**：优先看泄漏路径（值进 state／日志／错误文本／会话／审计）、引号拼装的注入面、
   `ctx.effect` 的资源释放与 fail-closed 缺口；特别关注 `src/` 四个文件之间的共享不变量
   （`store` 的记录形状、`card` 的 pending 生命周期、`use` 的引号与脱敏、`index` 的 scope 判定），
   以及 `scripts/verify.mjs` 的断言是否仍覆盖新行为。
2. **避免过度设计**：识别重复实现、无必要的抽象与冗余封装；只有存在更简单的等效方案时才
   报告，不误判必要的安全校验。
3. **严格控制范围**：改动应围绕目标，不夹带无关重构、格式化或依赖升级；必要的测试与文档
   同步除外。
4. **保证实质价值**：关注无效代码、重复逻辑与缺乏有效断言的测试；不以代码行数或提交次数判断贡献价值，不推测贡献者动机。
5. **审查必须有据**：只报告本次改动引入的实质问题，说明具体位置、触发条件与实际影响，
   优先给出最小修复建议，不为凑评论而挑刺。

## 编辑本文件

本文件就是仓库约定的真身（agent 直接读 `AGENTS.md`）。每条规则保持自包含，细节链接到权威文档；
表达在清晰存活时优先精简。
