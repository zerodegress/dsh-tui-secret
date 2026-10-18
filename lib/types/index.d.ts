/**
 * `dsh-tui-secret` — type surface.
 *
 * The package root exports two faces only: `name` and `apply` (no default export).
 * `Config` is deliberately not exported: the single configuration key `entryCommand`
 * falls back through `?? DEFAULTS` inside `apply`. See the README section on open
 * contract questions.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The name used as the Cordis row id. */
export declare const name: 'dsh-tui-secret'

/** The one configuration key (defaulted; a missing key degrades to the default behaviour and never breaks TUI startup). */
export interface Config {
  /** Slash-command name that opens the scene, without the slash. Defaults to `secrets`. */
  entryCommand?: string
  /** Scene title, for logs and debugging. Defaults to `Secrets`. */
  title?: string
}

export declare const DEFAULTS: Required<Config>

/**
 * Plugin entry: registers the `/secrets` full-screen scene and the command that opens it.
 * A missing scene seam degrades silently — nothing is registered, nothing throws, and TUI
 * startup is never at risk.
 */
export declare function apply(ctx: Context, config?: Config): void
