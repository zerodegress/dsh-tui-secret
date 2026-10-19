/** The env name the child will see; also returned to the model as `injectedAs`. */
export declare function injectedName(ref: string): string;
/** POSIX single-quote one argument so the shell cannot reinterpret a byte of it. */
export declare function quoteArg(arg: string): string;
/** Build the command string from the model's argv array, quoting every element. */
export declare function toCommand(argv: readonly string[]): string;
/** Replace every occurrence of the value with `[credential]`; best effort by design. */
export declare function redact(text: string, value: string): {
    text: string;
    hit: boolean;
};
/** The slice of `ctx.shell` we consume (typed structurally: no host package needed). */
export interface ShellSeam {
    resolve(request: {
        command: string;
        env?: Record<string, string>;
        timeoutMs?: number;
        onExpiry?: 'kill' | 'none';
        signal?: AbortSignal | undefined;
    }): unknown;
    execute(spec: unknown): Promise<{
        result(): Promise<ShellRunResultLike>;
    }>;
}
export interface ShellRunResultLike {
    exitCode: number | null;
    timedOut?: boolean;
    aborted?: boolean;
    stdout?: unknown;
    stderr?: unknown;
}
export interface UseResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /**
     * True when the value was found in the returned slice and replaced. False is **not** proof
     * that the output never held it: the executor's capture can be truncated, and a cut can land
     * in the middle of the value (or the command can transform it). What we guarantee is the
     * wording: this slice as returned carries no occurrence we could see.
     */
    redacted: boolean;
    /** The executor's first cause: a timeout on our deadline. */
    timedOut: boolean;
    /** The executor's first cause: the caller's signal fired. */
    aborted: boolean;
    injectedAs: string;
}
/**
 * Run `argv` with `value` in the child environment only. Returns the (best-effort) redacted
 * output; the caller records the audit trail (this function writes nothing).
 */
export declare function runWithCredential(shell: ShellSeam, input: {
    ref: string;
    argv: readonly string[];
    value: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
}): Promise<UseResult>;
