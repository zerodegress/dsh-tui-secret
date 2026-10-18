# 插件设计

[文档索引](README.md) · [项目首页](../README_ZH.md)

本插件把 DSH 已经具备的凭据接缝接到 dsh-TUI 的界面上：密钥由**用户**自己在终端里
输入，值只经凭据服务写入，插件本体不回显、不记日志、不进会话。本文记录设计依据、
威胁模型与实测事实；具体用法见[项目首页](../README_ZH.md)。

## 目标与非目标

目标是「让用户安全地在一个和 AI 共处的终端里交出一把密钥」——按键归用户、屏幕上不留
痕、值不经过会话。

非目标：不自建凭据存储；不做系统 keyring；不把值注入模型可执行的环境；不向上游提交
补丁（等 dsh-TUI 的设置区块自己渲染掩码后，本插件的场景可以退化成纯列表管理）。

## 事实基线（DSH 0.2.1-alpha.1 与 dsh-TUI 0.16.x 实读）

**凭据接缝只有四个操作，且没有枚举。**
`@deepseek-ai/dsh-credentials/lib/types/index.d.ts:56/63/72/79` 定义
`resolve` / `describe` / `set` / `unset`。因此「登记过哪些引用名」无法从接缝反推，必须
由插件自己记一份名字清单（只记名字）。

**文件 provider 的落点、权限与写盘三步。**
`dsh-credentials-local/lib/index.js:49` 的文件名常量 `.credentials.yaml`；
`:64` 的 `GROUP_OTHER_BITS = 63` 与 `:89` 的拒绝分支——文件对 owner 之外可读时**一律
拒绝启动**并要求 `chmod 600`；`:306` → `:311` 是它的写入序列：`withFileLock` 内
`reconcileFromDisk()` 重读，再 `writeFileAtomic`（0600 / 目录 0700）。

**锁与原子写的协议。**
`@deepseek-ai/dsh-atomic-write/lib/index.js:30` 的 `writeFileAtomic`（随机后缀同目录
临时文件 + `rename`）、`:59` 的 2 秒超时常量、`:72-73` 的 `withFileLock`——锁路径就是
`` `${filename}.lock` ``，以 `wx` 独占创建。任何第三方写入者只要用同一条路径派生，
就与 provider 互斥。

**dsh-TUI 的贡献面现状。**
TUI 贡献协议的设置区块字段类型只有 `text | number | boolean | select` 加一个可选的
`secretRef`，**没有 secret 输入类型**；`secret: { ref }` 的声明与 `credentialRefGuard`
（剔除 `DEEPSEEK_*` / `DSH_*`）在 0.16.0 已经存在，但设置屏尚未把该字段渲染成掩码。
所以「屏幕上不出现明文」这件事，v1 只能由自己渲染的**全屏场景**保证。

**凭据值不会自动进入模型 shell。**
`ctx.credentials` 的消费者是「按 ref 取值的插件」（LLM key 那类）。核心不会把凭据值
注入模型可执行的 shell，因此 v1 不注册 shellEnv 贡献者，也就不与其他插件的
`DSH_SECRET_*` 键空间产生归属冲突。

## 威胁模型

| 面 | 谁能读 | 本插件的处置 |
| --- | --- | --- |
| 屏幕 | 在场的人、终端回滚缓冲、终端录像 | 掩码是**固定长度占位**：既不回显字符，也不透露长度 |
| 会话转录 | 模型与所有历史读者 | 值不进任何会话事件；命令 handler 只返回静默 `success` |
| 工具结果与工具卡 | 模型、落库的 `tool/result` | 不注册工具；不挂 `tools/execute` |
| 模型请求 | 模型 | 不挂 `llm/stream` |
| 日志与错误 | 日志读者 | 只记名字与错误 `code`，不记原始错误文本（可能夹带值） |
| 凭据文件 | 同机用户 | 只要 provider 那一步：0600、目录 0700；文件本身永远是权威存储 |
| 进程环境 | 同机进程 | v1 不注册 shellEnv 贡献者，值不会出现在环境变量里 |

失败的默认是 fail-closed：值为空、名字非法、保留前缀、被环境遮蔽、文件权限过宽、
文件形状不可安全解析，一律拒绝而不写。

## 输入面

全屏场景（`ctx.tuiScenes`）由插件自己渲染，键盘所有权归场景，因此掩码由我们自己保证：

- 值存 `useRef`，**不进 React state**（state 会被调试器与序列化看到）；提交前先在本地
  丢弃，失败也不留在 state 里。
- 显示恒为固定长度占位，输入长度不参与渲染——按长度画点的掩码本身就泄漏信息。
- 每次按键只用一个「重绘计数」state 触发重绘（`src/index.ts` 的 `repaint()`），
  计数里装的永远是次数，不是值。

不使用宿主 `dialog.input()` 的原因同上：它是普通单行输入，没有 secret 选项。

## 存储与并发

| 内容 | 位置 | 权限 |
| --- | --- | --- |
| 值 | `<DSH_HOME>/.credentials.yaml`（由 provider 管） | 0600 |
| 引用记录（名字 + 授权） | `$DSH_TUI_HOME/dsh-tui-secret/refs.json` | 0600 / 目录 0700，原子写，损坏不覆盖 |
| 审计 | 同目录 `audit.jsonl` | 0600，追加写，只有名字/用途/时间/会话/exit code |

名字清单是索引而非密钥库：只有名字，没有值。它落在插件私有目录、不读 `.credentials.yaml`，
因为 provider 未必是文件实现，插件不应假定凭据存在哪里。

## 授权模型

**agent 侧只有两个 model-facing 工具**（运行期注册；宿主 registry 里没有 `tools.dsh` 协议组，
manifest 里不能声明工具）：

1. `request_credential(ref, purpose)` —— agent 发起请求，人在 `/secrets` 的卡片上决定；工具只回
   `stored / cancelled / refused`。值由人在卡片上输入、直接 `ctx.credentials.set(ref, value)` 落存储，
   **不经过工具结果**。请求被拒或被取消时**一个字节都不写**。
2. `use_credential(ref, argv)` —— 用该凭据跑**一条**命令：值放进 `ctx.shell` 那次执行的
   `spec.env`（`DSH_SECRET_<REF>`，由返回值 `injectedAs` 告知模型），不进会话环境；返回
   `{ exitCode, stdout, stderr, redacted, timedOut, aborted, injectedAs }`，输出里出现的值换成
   `[credential]`。`argv` 是数组，**由插件对每个元素做 shell 引号后拼成命令串** —— 模型喂不进裸
   shell 文本；要用管道或变量，它自己写 `["sh","-c","…"]`，由那层内层 shell 展开。

**四个 scope 全部在 `use_credential` 入口判定**（因为「用」这件事只经过这个工具）：

| scope | 判定 |
| --- | --- |
| `none` | 直接拒绝 |
| `once` | `useCount === 0` 才放行，放行后立刻撤销 |
| `session` | 记录里的 `SessionId` 等于本次 `exec.agent.id`；**恢复/继续同一个 session 后仍然有效，不自动清**（恢复会新建 agent，没有信号能判断会话不会回来），撤销靠人在场景里按 `v` / `R` |
| `until` | `Date.now() < expiresAt` |

**实现上依赖的一条宿主事实（读代码得到，未在真宿主上跑）**：`dsh-subprocess` 的环境 scrub 只作用于
**继承的父环境**（匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量不进子进程），显式 `spec.env` 在那之后
merge（`dsh-bash-local` 的注释写明 trusted caller 的条目仍然生效）—— 所以我们塞进 `spec.env` 的
`DSH_SECRET_<REF>` 不会被洗掉。这条是读代码的结论，落地后值得在真宿主上复跑一次。

**如实写明的边界**：闸门只对 agent 这条路（也就是这两个工具）有效；别的插件按同名
`credentials.resolve()` 取值，我们拦不住，也不假装拦得住。凭据库是明文、沙箱只限写，
有 `bash` 的 agent 可以直接读文件 —— 要挡住那条得靠 OS 级读限制（宿主/运维的活）。

## 消费面与脱敏

写入只走凭据接缝，因此消费面就是接缝本身：任何按 ref 取值的插件都能用到，无需本插件
再做一层。模型侧则**没有任何出口**——插件不注册工具、不挂模型相关的 cordis 事件，值
既不会出现在工具结果里，也不会出现在发给模型的请求里。

会话遥测（若有）属于另一条链路（`dsh-session-telemetry` 的 `session-telemetry/record`
waterfall），本插件不写遥测，因此不需要在那里挂脱敏规则。

## 验证

`npm test` = `npm run compile` + `scripts/verify.mjs`，两层证据（源代码是 `src/` 里的
TypeScript，`lib/` 是 `tsc` 的产物、不进 git，所以验证跑的是编译产物）：

- **场景层**（`①–⑫`）：自写最小 React hook runtime 与 ui kit 替身，把场景真正跑起来，
  按真人按键顺序驱动，记录每一帧渲染字符串、每一条日志、每一次对外调用，再用哨兵值
  grep。其中 `⑫` 换成宿主自己的 React 19 与 ink，渲进非 TTY 流逐帧 grep——元素符号、
  hook dispatcher、渲染路径都是真的。
- **引号与 shell 边界层**（`⑬–⑮`）：把插件拼出来的命令串真的交给 `/bin/sh` 跑 —— 恶意
  `argv`（`;`、`$()`、反引号、引号、换行、空串）必须原样当数据到达；值只在模型**自己写的**
  `["sh","-c","…"]` 里展开，且展开后的输出照样被换成 `[credential]`。
- **工具与权限层**（`㉑–㉟`）：用假宿主驱动两个工具 —— 运行期注册、未授权即拒绝且不启动命令、
  值只进那一次执行的 `spec.env`（父进程环境逐字节不变）、四个 scope 的入口判定、`once` 用后即撤、
  `until` 到期、`session` 按 session id 且不自动清、审计无值、拒绝/取消零写入、v1 记录兼容、
  `v` / `R` 撤销、没有 shell 面与没有 TUI 前台时的降级、卡片来回（选 scope → 掩码输入 → 落存储，
  settle 里不含值）。

它不覆盖真机 TTY 的回滚缓冲与终端录像，也覆盖不到终端之外的写入方（Web 卡片、`dsh`
自己写同一份凭据文件）；这些需要真实终端手测。

## 契约与待确认

1. **`Config` 未导出**：唯一配置键 `entryCommand` 在 `apply` 内用 `?? DEFAULTS` 兜底。
   若 profile 的 manifest 校验要求 Schemastery 的 `Config`，补十行即可。
2. **命令注册路径**：默认走 plugin-host 托管面
   `ctx.tuiPluginHost.registerCommand(ctx, definition)`（带 verified 归属，宿主的
   `commands.invoke` denies 才对它生效），托管面缺失或被拒时退回 `ctx.commands.register`
   直注册。`dsh-plugin.json` 声明的贡献 id 与注册的命令名不必同名。

## 兼容性

- 只支持 `@deepseek-harness-tui/dsh-tui` 0.16.x；其他 TUI 实现不在目标内。
- Node `^22.19 || >=24`；ESM；无运行时依赖；构建依赖只有 `typescript` / `@types/node` /
  `@deepseek-ai/cordis`（首次要联网 `pnpm install`，`lib/` 不入库）。
- 接缝缺席时静默降级：场景面不在就什么都不注册，绝不拖垮 TUI 启动；工具面不在就两个工具都不注册。
- **局限（如实写）**：凭据库是明文 YAML、沙箱只限写 → 有 `bash` 的 agent 能直接读；脱敏只覆盖
  那一次执行的返回片段（编码或截断后的副本认不出，断言 `㊱`/`㊲` 钉住这一点）；闸门只对 agent
  这条路有效（别的插件按同名 resolve 就能取值）；**短凭据**（场景允许 2 字符）会把输出里所有
  同串都替换掉、结果可能难读 —— 替换是安全侧的选择（只替换一次会漏值），单遍实现因此不会把
  占位符自身再替换成 `[[credential]]`（断言 `㊳`）。
