import type { Context } from '@deepseek-ai/cordis';
export declare const name: "dsh-tui-secret";
/** The one configuration key (defaulted; a missing key degrades to the default behaviour and never breaks TUI startup). */
export interface Config {
    /** Slash-command name that opens the scene, without the slash. Defaults to `secrets`. */
    entryCommand?: string;
    /** Scene title, for logs and debugging. Defaults to `Secrets`. */
    title?: string;
}
/** Exported for tests and documentation: the defaults this plugin declares. */
export declare const DEFAULTS: Required<Config>;
/**
 * Plugin entry. Registers two seams declaratively through ctx.inject; every resource is
 * disposed on the fibre that called apply.
 *
 * @param ctx - the Cordis context.
 * @param config - from cordis.patch.yml.
 */
export declare function apply(ctx: Context, config?: Config): void;
