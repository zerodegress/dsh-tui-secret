/**
 * `dsh-tui-secret` —— type surface.
 *
 * 插件包根只导出两个面：`name` 与 `apply`（无默认导出）。`Config` **不导出**：
 * 唯一的配置键 `entryCommand` 在 apply 内用 `?? DEFAULTS` 兜底。见 README
 * 「插件契约的两个待确认项」。
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis 行 id 使用的名字。 */
export declare const name: 'dsh-tui-secret'

/** 唯一配置键（全部带默认值；键缺失时退化为默认行为，绝不让 TUI 起不来）。 */
export interface Config {
  /** 打开场景的 slash 命令名（不带斜杠）。默认 `secrets`。 */
  entryCommand?: string
  /** 场景标题（调试与日志用）。默认 `Secrets`。 */
  title?: string
}

export declare const DEFAULTS: Required<Config>

/**
 * 插件入口：注册 `/secrets` 全屏场景与打开它的命令。
 * 场景面（tuiScenes）缺失时静默降级——不注册、不报错、不拖垮 TUI 启动。
 */
export declare function apply(ctx: Context, config?: Config): void
