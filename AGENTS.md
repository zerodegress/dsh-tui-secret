# AGENTS.md

dsh-tui-secret 是 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的密钥录入插件：一个
`/secrets` 全屏场景（自绘掩码输入、引用列表、删除确认）加一个同代码的命令行。值只经 DSH
的凭据接缝写入，插件本体不回显、不记日志、不进会话。改动前先读
[README_ZH.md](README_ZH.md)（用户视角）与 [docs/plugin-design.md](docs/plugin-design.md)
（设计依据、威胁模型与实测事实）；插件契约与接缝的权威文本在
[上游插件准入与开发指南](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/tui-profile/docs/plugin-admission-and-development.md)。

## 仓库布局

```
lib/types/index.js   Cordis 插件入口：name / apply、/secrets 场景、打开它的命令
lib/types/cli.js     命令行实现：list / set / rm、同锁行级 upsert、fail-closed 判据
lib/types/store.js   引用名清单（只有名字）：$DSH_TUI_HOME/dsh-tui-secret/refs.json
lib/types/index.d.ts 包根的公开类型面
bin/dsh-tui-secret.mjs  bin 薄入口，实现全在 lib/types/cli.js
scripts/verify.mjs   验收脚本（npm test）：场景哨兵验证 + 命令行写盘协议验证
docs/                根 README 之外的文档；中文无后缀，英文 .en.md
cordis.patch.yml     profile 组合用的包级覆盖层；本包只有一行插件
dsh-plugin.json      插件声明（contracts / contributes / permissions）
```

**`lib/` 就是这个包的源码，不是构建产物**（与上游 dsh-TUI 的 `src/` → `lib/` 不同），
没有编译步骤，直接改这里。

完整仓库地图、设计依据与实测事实见 [docs/plugin-design.md](docs/plugin-design.md)；
文档索引见 [docs/README.md](docs/README.md)。

## 命令

```sh
npm test        # = node scripts/verify.mjs：场景 ①–⑫ + 命令行 ⑬–⑲ + ⑳ 声明闸门，21/21 PASS 为通过
npm run verify  # 同一入口
npm pack --dry-run          # 检查发布内容（npm 缓存不在工作区时加 npm_config_cache=<目录>）
dsh plugin --profile dsh-tui add <本仓路径>   # 本地试装（会动 profile，先问维护者）
```

仓库**没有** lint、类型检查或根级测试框架：静态关口是 `node --check`，行为验证就是
`scripts/verify.mjs`。脚本里对宿主真件的两处交叉验证（用宿主 `yaml` 包解析回读、用
provider 真 `withFileLock` 占锁）在缺件时打印 `SKIP`，`SKIP` 不算失败，但**不要**把
`SKIP` 当通过报出去。

## 上游边界与契约

- 只消费公开面：dsh-TUI 的 `ctx.tuiScenes` / `ctx.commands`，DSH 的 `ctx.credentials`。
  官方源码不改，行为差异落配置层或本包。
- 不注册 `shellEnv` 贡献者：`DSH_SECRET_*` 那套键空间属于别的插件，v1 不碰。
- 场景面缺席时静默降级（什么都不注册），绝不拖垮 TUI 启动；接入面存在但用错时（如
  `open()` 返回 false）要**响亮报错**，不静默。
- 可选的宿主面一律 `ctx.get(name, false)` 软探测，不放进 `inject` 列表。

## 约定与红线

- **值永不落屏、落盘（除凭据存储）、落日志**：只走 `ctx.credentials`；命令行只按
  provider 同一把锁与同一套原子写改那个文件。任何把值写进 state、日志、错误文本或
  会话的改动都视为回归。
- **fail-closed**：任何前提缺失（空值、非法名、保留前缀、被环境遮蔽、权限过宽、
  文件形状不可安全解析、等不到锁）都拒绝退出，不猜、不静默降级。
- **文本语言**：源码注释、用户可见的界面与命令行文案、测试标签一律英文（与上游默认一致）；
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
- 改动场景或命令行语义时，同步更新 `scripts/verify.mjs`（它是这两个面的唯一回归网）与
  两份 README 的验证段。

## 代码审查原则

审查改动时，以**不引入新 Bug、最小必要改动、保持代码简洁**为核心原则：

1. **防止回归**：优先看新增的泄漏路径（值进 state／日志／错误文本／会话）、竞态（锁与锁内
   重读）、资源泄漏（`ctx.effect` 缺清理）与 fail-closed 缺口。
2. **避免过度设计**：识别重复实现、无必要的抽象与冗余封装；只有存在更简单的等效方案时才
   报告，不误判必要的安全校验。
3. **严格控制范围**：改动应围绕目标，不夹带无关重构、格式化或依赖升级；必要的测试与文档
   同步除外。
4. **保证实质价值**：关注无效代码与缺乏有效断言的测试；不以代码行数或提交次数判断贡献。
5. **审查必须有据**：只报告本次改动引入的实质问题，说明具体位置、触发条件与实际影响，
   优先给出最小修复建议。

## 编辑本文件

本文件就是仓库约定的真身（agent 直接读 `AGENTS.md`）。每条规则保持自包含，细节链接到权威文档。
