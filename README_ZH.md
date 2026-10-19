<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-4b6fff?style=flat-square">
  <img alt="dsh-TUI plugin" src="https://img.shields.io/badge/dsh--TUI-plugin-7da1de?style=flat-square">
</p>

# dsh-tui-secret

> 给 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 用的密钥录入插件：`/secrets`
> 打开一个全屏场景，**掩码录入 → 引用列表 → 删除确认**。值只经 DSH 自己的凭据接缝
> 写入，插件本体不回显、不记日志、不进会话。
>
> agent 也可以主动来要：`request_credential` 把一张掩码卡片推到你面前，值直接进 DSH
> 凭据存储，工具只拿到一个状态；`use_credential` 再用它跑**一条**命令，值只在那**一个子进程**
> 的环境里，返回的输出里凡是出现值的地方都换成 `[credential]`。

## 功能亮点
- **场景内掩码录入** — `/secrets` 打开一个全屏场景：按 `a` 新建引用，逐字掩码输入，`Enter` 写入。
- **固定长度掩码** — 不论多长都是 `••••`：屏幕上既没有字符，也看不出长度。
- **agent 来要，你决定** — `request_credential(ref, purpose)` 弹卡片：名字、用途，以及四个
  选项：不允许 / 仅本次 / 仅本会话 / 到某个时刻。
- **只存好，不交出去** — 值只到 `ctx.credentials`；工具结果里只有状态，值不进会话。
- **能用它，但拿不走它** — `use_credential(ref, argv)` 跑一条命令，值只在那一个子进程里，
  返回输出里出现的值一律换成 `[credential]`。
- **列表、删除与撤销，值永不上屏** — 列表出「是否已配置」+ agent 授权；`d` 删除（要 `y`）、
  `v` 撤销单条授权、`R` 一键全撤。
- **声明有闸门** — `npm test` 会把 `dsh-plugin.json` 送进宿主自己的解析器与 TUI profile
  校验器，manifest 一漂本地就红。


## 快速开始
支持目标：**`@deepseek-harness-tui/dsh-tui`** 0.16.x —— 其他 TUI 实现不在目标内。

```sh
dsh plugin --profile dsh-tui add dsh-tui-secret
```

或在 profile 的 `cordis.patch.yml` 里插一行（本包的 `cordis.patch.yml` 就是这一行，
装包时由 bundle 机制自动应用）：

```yaml
- insert:
    - id: dsh-tui-secret
      name: dsh-tui-secret
      config:
        entryCommand: secrets   # 可以改成别的命令名
```

装完重启 TUI，输入 `/secrets`。

### 两个 agent 工具
两个工具在**运行期**注册（宿主没有工具类的 manifest 契约）：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `request_credential` | `ref`、`purpose` | `stored` / `cancelled` / `refused` |
| `use_credential` | `ref`、`argv[]`、`timeoutMs?` | `exitCode`、`stdout`、`stderr`、`redacted`、`timedOut`、`aborted`、`injectedAs` |

`use_credential` 只跑一条命令。值进的是**那个子进程**的环境，变量名就是返回给你的
`injectedAs`；它不会进你或 agent 所在的 shell，执行器该有的沙箱策略照样生效。`argv` 是数组，
每个元素由插件引号包裹 —— 模型喂不进裸 shell 文本；要用管道或变量，它得自己写
`["sh","-c","…"]`，由那层内层 shell 展开。

值由**你**在卡片上输入。两个工具都不接受模型给的值，也都不返回值。

## 快捷键
界面文案为英文（与上游默认一致），下方键位与说明为中文。

| 键 | 作用 |
| --- | --- |
| `a` | 新建引用：先输名字，再输值 |
| `d` | 删除光标所在的引用（再按 `y` 确认） |
| `v` | 撤销光标所在引用的 agent 授权 |
| `R` | 撤销全部 agent 授权（再按 `y` 确认；值保留） |
| `↑` `↓` | 移动选择 |
| `Enter` | 下一步 / 写入 |
| `Esc` | 返回上一层；列表里按 `Esc`（或 `q`）关屏 |

agent 发起的卡片上：`1`–`4`（或 `↑`/`↓`）选授权范围，`Enter` 下一步，`r` 拒绝，`Esc` 取消。

名字规则与 DSH 一致：大写字母开头，只含 `A-Z 0-9 _`，≤64 字符；`DEEPSEEK_` / `DSH_`
开头归宿主所有，插件当场拒绝并说明理由（dsh-TUI 的 `credentialRefGuard` 在这些前缀上
本来也会剔掉插件自己的 ref，这里提前给出可读的理由，而不是等宿主静默丢弃）。

## 工作原理
- **值只走 `ctx.credentials.set(ref, value)`**：不另开文件、不写 `.credentials.yaml`
  本体、不复制值到别处。空值被拒（DSH 语义里空值等于未配置）。
- **值不进 React state**：存 `useRef`，提交前先在本地丢弃，失败也不留在 state 里。
- **掩码是固定长度占位（`••••`）**：既不回显字符，也不透露长度——按长度画点的掩码
  本身就会泄漏信息。
- **不注册 shellEnv 贡献者**：`$NAME` 不进模型可执行的环境；唯一持有它的环境是
  `use_credential` 为那一次调用拉起的子进程。
- **模型侧只有两个出口**：`request_credential`（只回状态）与 `use_credential`（只回 exit code 与脱敏输出）；除此之外不挂任何 model-facing 面。
- **四个 scope 全在 `use_credential` 入口判定**：`none` 直接拒；`once` 用完即撤；`session` 比 session id（恢复会话后仍有效，不自动清）；`until` 到期即撤。
- **日志与报错只记名字与错误 `code`**：原始错误文本可能夹带值，一律不上屏、不落盘。
- **列表只出「是否已配置 / 来源 / 可写性」**：来自 `credentials.describe()`，它按设计
  就不返回值。

这些断言不是靠读源码得出的：`npm test` 会把场景真正跑起来逐帧检查，详见「开发」。

- **接缝** —— `ctx.tuiScenes`（全屏场景）、`ctx.commands`（命令）、`ctx.credentials`
  （DSH 核心凭据服务）。场景面缺失时静默降级为「什么都没发生」，绝不拖垮 TUI 启动。
## 存储
| 内容 | 位置 | 权限 |
| --- | --- | --- |
| 值（由 DSH 管） | `<DSH_HOME>/.credentials.yaml` | provider 保证 0600 |
| 引用记录（本插件） | `$DSH_TUI_HOME/dsh-tui-secret/refs.json`（默认 `~/.dsh-tui/…`） | 文件 0600、目录 0700，原子写 |
| 审计（本插件） | 同目录 `audit.jsonl`（每行一条：名字、用途、时间、会话、exit code） | 文件 0600，追加写 |

名字清单为什么要自己存：`ctx.credentials` 的接口只有
`resolve / describe / set / unset`——**没有 list()**，所以「登记过哪些名字」无法反推。
这份 `refs.json` 记的是**名字 + agent 授权**（`none/once/session/until`、用途、时间、用了几次），
**只有名字没有值**，不是密钥库；文件损坏时读作空表，绝不覆盖原字节。v1 的旧格式
（`{version:1,names:[…]}`）会被自动读成 v2。

生态里插件私有数据的正规位置是 `ctx.get('tuiPluginStorage', false)` 的 `storage.local`
（落 `~/.dsh-tui/plugin-storage/<namespace>.json`），但它的 `storage.local.read/write`
默认**拒绝**、要写 `~/.dsh-tui/extension-grants.json` 才通。v1 选择零授权，因此先落在
上面那个插件私有目录。

## 已知限制
- **凭据库是明文**：DSH 把值存成 `<DSH_HOME>/.credentials.yaml`（不加密）、权限 0600 ——
  只挡同机其他用户；沙箱只限写、不限读。所以**有 `bash` 的 agent 直接 `cat` 就能拿到**。
  要挡住这条得靠 OS 级读限制、或把值挪出该用户可达范围（宿主/运维的活），不是本插件能给的。
- **脱敏只覆盖那一次执行的返回片段**：值不会出现在我们产生的工具结果里，但命令可以把它
  写进文件/网络/日志再取回；被截断或变换过的副本也认不出。`redacted: false` 的含义是
  「返回的这段里没检测到」，不是「输出里从来没有过」。
- **闸门是我们自己的，不是存储的**：别的插件按同名 `credentials.resolve(ref)` 直接就能拿到值
  ——我们不假装拦得住；我们能保证的那句更窄也真实：**凡走 agent 这条路的，都从这两个工具过**。
- **短凭据会让输出难读**：脱敏替换**所有**出现（安全侧的选择——只替换一次会漏值），而场景允许
  2 字符的凭据，所以一条短值会把命令输出里所有同串都换掉。实现是**单遍**替换，所以值恰为
  `credential` 时占位符不会被再替换一次；卡片上常驻一句提示（不做「短值才提示」，那会泄漏长度）。
- **`session` 授权不会自己过期**：恢复会话会新建 agent、session id 不变，所以没有任何信号能
  判断「这个会话不会回来了」。要收就自己按 `v` / `R` 撤，或删掉那个引用；会自失效的只有
  `once` 与 `until`。
- **不做系统 keyring**（keyring / DPAPI）：按 DSH 的存储语义走。
- **不向上游提交补丁**：dsh-TUI 的设置区块已经声明了 `secret: { ref }` 字段，等它的
  设置屏自己把掩码渲染补上，这个场景可以退化成纯列表管理。

## 开发
```sh
pnpm install    # 首次：装构建依赖（typescript / @types/node / @deepseek-ai/cordis，仅构建用）
npm test        # = npm run compile && node scripts/verify.mjs
```

源码是 `src/` 里的 TypeScript；`tsc` 把它编译进 `lib/types/` —— 宿主加载的是它，
npm 包发的也是它。`lib/` 是产物、不进 git。

脚本覆盖三层加一道闸门：`①–⑫` 场景（哨兵验证，含真 ink 渲染）、`⑬–⑮` 引号与 shell 边界
（跑真 `/bin/sh`）、`㉑–㊴` 两个工具与权限表（注册、拒绝、四个 scope、审计、脱敏的两条诚实边界、撤销、降级、卡片来回、
拒绝 note 的原因码）、
`⑳` 插件声明 —— 用宿主自己的 `@dsh-std/manifest` 解析器与 TUI profile 校验器离线跑一遍，
manifest 一漂当场就红。

**排障**：`/secrets` 报「the secrets scene is not registered」时，括号里带短原因码 ——
`registration failed: <code>`（注册那一步抛了，日志里也有同一句，只记 code/name 不记原始文本）
或 `the host does not have it in the scene registry`。卡片总是 `refused` 时，用
`DSH_TUI_SECRET_DEBUG=1` 起 TUI —— `request_credential` 的 note 会附上具体原因
（`the host did not open the scene`、`the card was answered with refuse`、`the tool call was aborted`…），
里面永远没有值。默认不区分「人拒绝」与「卡片弹不出来」，以免失败原因变成可探测的侧信道。

- **场景那半**实现一份最小 React hook runtime 与 ui kit 替身，**把场景真正跑起来**，按
  真人按键顺序驱动（`a` → 名字 → `Enter` → 值 → `Enter`），把每一帧渲染字符串、每一条
  日志、每一次对外调用记入记录，再用哨兵值 grep。其中 `⑫` 换成宿主自己的 React 19 与
  ink，把场景渲进非 TTY 流逐帧 grep——元素符号、hook dispatcher、渲染路径都是真的。
- **两个工具**用一个假宿主驱动（和场景用假 React 一个路子），引号那组则把拼出来的命令
  真的交给 `/bin/sh` 跑：恶意参数必须原样当数据，只有模型自己写的脚本才允许展开。

工具链：Node `^22.19 || >=24`，ESM，无运行时依赖；`@deepseek-ai/cordis` 是可选 peer。三个
devDependencies 只服务构建与类型 —— 新克隆的仓库要先 `pnpm install`（联网）再 `npm test`。
未决的契约项集中记在 [docs/plugin-design.md](docs/plugin-design.md)。

## 文档
- **设计** —— [plugin-design.md](docs/plugin-design.md) · [文档索引](docs/README.md)
  · [dsh-TUI 插件指南](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/tui-profile/docs/plugin-admission-and-development.md)
## License
[MIT](LICENSE)
