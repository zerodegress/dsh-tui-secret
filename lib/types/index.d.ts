import type { Context } from '@deepseek-ai/cordis';
export declare const name: "dsh-tui-secret";
/**
 * How the value line echoes what was typed.
 * - `dots` (default): one `•` per character, like a conventional password field. The length is
 *   visible; the characters are not.
 * - `none`: no per-keystroke output at all. The label stays put while the value is typed blind.
 */
export type EchoMode = 'dots' | 'none';
/** Configuration keys (all defaulted; a missing key degrades to the default behaviour and never breaks TUI startup). */
export interface Config {
    /** Slash-command name that opens the scene, without the slash. Defaults to `secrets`. */
    entryCommand?: string;
    /** Scene title, for logs and debugging. Defaults to `Secrets`. */
    title?: string;
    /** Echo mode for the value line. Defaults to `dots`; `none` hides even the length. */
    echo?: EchoMode;
}
/** Exported for tests and documentation: the defaults this plugin declares. */
export declare const DEFAULTS: Required<Config>;
/**
 * Plugin entry. Registers the scene, the slash command and the two model-facing tools; every
 * resource is disposed on the fibre that called apply.
 *
 * @param ctx - the Cordis context.
 * @param config - from cordis.patch.yml.
 */
export declare function apply(ctx: Context, config?: Config): void;
