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
> 同一份代码另带一个 `dsh-tui-secret` 命令行，给脚本与无 TTY 场景使用：它不绕开 DSH
> 的存储，而是与凭据 provider **共用同一把写锁与同一套原子写**。

## 安装

```bash
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

## 用法（场景）

界面文案为英文（与上游默认一致），下方键位与说明为中文。

| 键 | 作用 |
| --- | --- |
| `a` | 新建引用：先输名字，再输值 |
| `d` | 删除光标所在的引用（再按 `y` 确认） |
| `↑` `↓` | 移动选择 |
| `Enter` | 下一步 / 写入 |
| `Esc` | 返回上一层；列表里按 `Esc`（或 `q`）关屏 |

名字规则与 DSH 一致：大写字母开头，只含 `A-Z 0-9 _`，≤64 字符；`DEEPSEEK_` / `DSH_`
开头归宿主所有，插件当场拒绝并说明理由（dsh-TUI 的 `credentialRefGuard` 在这些前缀上
本来也会剔掉插件自己的 ref，这里提前给出可读的理由，而不是等宿主静默丢弃）。

## 命令行

```bash
dsh-tui-secret list [--json]                 # 只列名字与状态，永不列值
dsh-tui-secret set NAME --from-stdin         # 从标准输入读值
dsh-tui-secret set NAME --from-file ./k.txt  # 从文件读值
dsh-tui-secret set NAME                      # 在 TTY 上：一次无回显输入
dsh-tui-secret rm NAME --yes                 # 删除（缺 --yes 一律拒绝）
```

值永不进入 argv。读写按原样、不做 trim（`echo` 会带一个换行进来，请用 `printf '%s'`）；
写入后只报字节数，便于核对。

它与场景那半共存的前提：

- **同一把锁**：`<凭据文件>.lock` 的 `wx` 独占创建，2 秒等不到就**报错退出**，不猜锁
  是否还有持有者。这把锁就是 provider 自己用的那把（同一条路径派生）。
- **同一套原子写**：随机后缀同目录临时文件 + `rename`，0600 / 目录 0700。
- **锁内重读**：拿到锁后重新读一遍文件再改，其他写入者刚提交的内容不会被覆盖。
- **行级 upsert**：只重写目标键占的那几行——其他键、注释、键序与块标量
  （值里带换行时 provider 写成 `KEY: |`）原样保留。
- **fail-closed**：非 TTY 且不给 `--from-stdin`/`--from-file`、值为空、名字非法、
  `DEEPSEEK_`/`DSH_` 前缀、该名字被当前环境变量遮蔽（写进去也会被遮蔽成「看起来成功」）、
  凭据文件权限宽于 0600 —— 一律退出码 2、不落盘。文件里出现嵌套映射或重复键时同样
  拒绝改写。
- 退出码：`0` 成功，`1` 运行失败，`2` 拒绝或用法错误。

provider 默认开启文件监听（`watch: true`），外部改完会自行 reload；若某个部署关掉了
`watch`，正在运行的会话要等下一次读才看到新值。

`list` 直接读凭据文件里的键（这才是「存了哪些」的事实来源），再并上名字清单里只在
场景中登记过的名字。场景那半列的是名字清单，不读凭据文件——provider 未必是文件实现，
插件不应该假定它存在哪里。

## 值如何不被泄漏

- **值只走 `ctx.credentials.set(ref, value)`**：不另开文件、不写 `.credentials.yaml`
  本体、不复制值到别处。空值被拒（DSH 语义里空值等于未配置）。
- **值不进 React state**：存 `useRef`，提交前先在本地丢弃，失败也不留在 state 里。
- **掩码是固定长度占位（`••••`）**：既不回显字符，也不透露长度——按长度画点的掩码
  本身就会泄漏信息。
- **不注册 shellEnv 贡献者**：`$NAME` 不会出现在模型可执行的环境里，也不会与 ds-bot
  那套 `DSH_SECRET_*` 争用同一个键空间。
- **不注册工具、不挂 `ctx.on('tools/execute' | 'llm/stream')`**：模型侧没有出口，
  值进不了 tool-result / tool-card / llm-stream 三条通路。
- **日志与报错只记名字与错误 `code`**：原始错误文本可能夹带值，一律不上屏、不落盘。
- **列表只出「是否已配置 / 来源 / 可写性」**：来自 `credentials.describe()`，它按设计
  就不返回值。

这些断言不是靠读源码得出的：`npm test` 会把场景真正跑起来逐帧检查，详见「验证」。

## 存储

| 内容 | 位置 | 权限 |
| --- | --- | --- |
| 值（由 DSH 管） | `<DSH_HOME>/.credentials.yaml` | provider 保证 0600 |
| 引用名清单（本插件） | `$DSH_TUI_HOME/dsh-tui-secret/refs.json`（默认 `~/.dsh-tui/…`） | 文件 0600、目录 0700，原子写 |

名字清单为什么要自己存：`ctx.credentials` 的接口只有
`resolve / describe / set / unset`——**没有 list()**，所以「登记过哪些名字」无法反推。
这份 `refs.json` **只有名字**，是引用名的索引，不是密钥库；文件损坏时读作空表，
绝不覆盖原字节。

生态里插件私有数据的正规位置是 `ctx.get('tuiPluginStorage', false)` 的 `storage.local`
（落 `~/.dsh-tui/plugin-storage/<namespace>.json`），但它的 `storage.local.read/write`
默认**拒绝**、要写 `~/.dsh-tui/extension-grants.json` 才通。v1 选择零授权，因此先落在
上面那个插件私有目录。

## 边界

- **命令行不是第二套存储**：它写的就是 provider 那个文件、用 provider 那把锁。它**没有**
  provider 的语义完整性——例如 provider 会拒绝「被环境遮蔽」的写入，命令行只能按自己
  进程的环境判断，会话从别的 shell 启动时判据可能不同。
- **不注入 shell**：v1 只写凭据存储，供按 ref 消费 credentials 的插件（LLM key 那类）
  使用。要让模型 shell 里出现 `$NAME`，需要额外注册 shellEnv 贡献者，并先确定不与
  ds-bot 撞键的前缀。
- **不做系统 keyring**（keyring / DPAPI）：按 DSH 的存储语义走。
- **不向上游提交补丁**：dsh-TUI 的设置区块已经声明了 `secret: { ref }` 字段，等它的
  设置屏自己把掩码渲染补上，这个场景可以退化成纯列表管理。

## 验证

```bash
npm test        # = node scripts/verify.mjs
```

脚本覆盖两半加一道闸门：`①–⑫` 是场景（哨兵验证），`⑬–⑲` 是命令行（写盘协议与
fail-closed），`⑳` 是插件声明 —— 用宿主自己的 `@dsh-std/manifest` 解析器与 TUI profile 校验器
离线跑一遍，manifest 一漂当场就红。

- **场景那半**实现一份最小 React hook runtime 与 ui kit 替身，**把场景真正跑起来**，按
  真人按键顺序驱动（`a` → 名字 → `Enter` → 值 → `Enter`），把每一帧渲染字符串、每一条
  日志、每一次对外调用记入记录，再用哨兵值 grep。其中 `⑫` 换成宿主自己的 React 19 与
  ink，把场景渲进非 TTY 流逐帧 grep——元素符号、hook dispatcher、渲染路径都是真的。
- **命令行那半**用子进程跑真实入口，并调用宿主的 `yaml` 包把文件解析回来比对值、
  用 provider 真正的 `withFileLock` 占锁对撞。

当前 `21/21 PASS`：

```
PASS  ① an empty value is refused: Enter writes nothing
PASS  ② a reserved prefix is refused: DSH_ names are not accepted
PASS  ③ per-keystroke masking: only a fixed mask on screen, no value and no length
PASS  ④ the value reaches credentials.set only: zero hits in frames and logs
PASS  ⑤ a short value (2 characters) also stays off screen
PASS  ⑥ deletion needs an explicit y; any other key deletes nothing
PASS  ⑥b with credentials missing, deletion is not reported as done
PASS  ⑦ Esc closes the scene
PASS  ⑧ a failed write reports the error code only, never the value or raw error text
PASS  ⑨ apply touches two seams only and mounts no model-facing hook
PASS  ⑩ the name index holds names only; file 0600, directory 0700
PASS  ⑪ a damaged name index is neither overwritten nor fatal
PASS  ⑫ real host render (real React + real ink): the mask repaints and no value lands on screen
PASS  ⑬ cli set: a row-level upsert — comments, other keys and block scalars survive
PASS  ⑭ cli set over an existing key: only that row changes, every other byte stays
PASS  ⑮ cli and provider share one lock: a held lock means an error exit and no write
PASS  ⑯ cli fail-closed: no source / empty value / reserved prefix / shadowed / wide mode all refuse and write nothing
PASS  ⑰ cli rm: refused without --yes; with it, only that key goes
PASS  ⑱ cli list: names and state only, no value anywhere in the output
PASS  ⑲ cli set --dry-run: no write, no lock
PASS  ⑳ the declaration passes the upstream parser and the TUI profile gate
```

其中 `⑫` 依赖本机装有 dsh-TUI profile，未安装时 `SKIP`（可用 `DSH_TUI_PROFILE=` 指定
位置），不算失败；`⑬⑮` 里对宿主 `yaml` 与 provider 真锁的两处对撞同样在缺件时 `SKIP`。

它**不能**证明的：真机 TTY 的回滚缓冲与终端录像、终端之外的写入方（Web 卡片、`dsh`
CLI 自己写同一份凭据文件）。这些要看真实终端，脚本不代替手测。

## 兼容性

- 只支持 **`@deepseek-harness-tui/dsh-tui`**（0.16.x 实读；其他 TUI 实现不在目标内）。
- Node `^22.19 || >=24`；ESM；无运行时依赖，`@deepseek-ai/cordis` 是可选 peer。
- 接缝：`ctx.tuiScenes`（全屏场景）、`ctx.commands`（命令）、`ctx.credentials`
  （DSH 核心凭据服务）。场景面缺失时静默降级为「什么都没发生」，绝不拖垮 TUI 启动。

## 待确认的契约项

1. **`Config` 没有导出**：插件指南写的三个面是 `name` / `Config` / `apply`；本包唯一的
   配置键 `entryCommand` 在 `apply` 内用 `?? DEFAULTS` 兜底，没有导出 Schemastery 的
   `Config`。若 profile 的 manifest 校验要求它存在，补一个 `@deepseek-ai/schemastery` 的
   `Schema.object({...}).default(...)` 即可。
2. **命令的注册路径**：默认走 plugin-host 托管面
   `ctx.tuiPluginHost.registerCommand(ctx, definition)`，命令因此带上本插件的 verified
   归属（宿主 `commands.invoke` 的 denies 才能对它生效）；托管面缺失或注册被拒时退回
   `ctx.commands.register` 直接注册（同进程信任边界）。`dsh-plugin.json` 里的贡献 id 是
   `dsh-tui-secret.open`，与注册的命令名 `secrets` 不必同名——贡献 id 是声明身份，
   不是命令名。

设计说明见 [docs/plugin-design.md](docs/plugin-design.md)。

## 许可

[MIT](LICENSE)
