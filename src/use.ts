// `use_credential`'s working half: run one command with the value present in exactly one
// child process, then hand back output that no longer contains it.
//
// Facts this file is built on (design §2.3):
//   - `ctx.shell.resolve(request) → spec`, `ctx.shell.execute(spec) → handle`,
//     `await handle.result()` → `{ exitCode, signal, timedOut, aborted, stdout, stderr, … }`.
//   - `ShellExecRequest.command` is a command **string**, so the plugin quotes every argv
//     element itself: the model never supplies raw shell text.
//   - The value goes into `spec.env` (any key). `dshEnv` only accepts `DSH_*` and would reject
//     a name like `DEEPSEEK_API_KEY`; `env` is not a model-visible parameter either.
//   - The executor owns the sandbox policy, the deadline and the kill semantics; we never
//     spawn around it.
const INJECTED_PREFIX = 'DSH_SECRET_'

/** The env name the child will see; also returned to the model as `injectedAs`. */
export function injectedName(ref: string): string {
  return `${INJECTED_PREFIX}${ref}`
}

/** POSIX single-quote one argument so the shell cannot reinterpret a byte of it. */
export function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Build the command string from the model's argv array, quoting every element. */
export function toCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('argv must contain at least one element')
  return argv.map(quoteArg).join(' ')
}

/** Replace every occurrence of the value with `[credential]`; best effort by design. */
export function redact(text: string, value: string): { text: string; hit: boolean } {
  if (!value || !text.includes(value)) return { text, hit: false }
  return { text: text.split(value).join('[credential]'), hit: true }
}

/** The output shapes a shell result can carry; we only ever read text out of them. */
function textOf(output: unknown): string {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    const candidate = output as { text?: unknown; value?: unknown; buffer?: unknown }
    if (typeof candidate.text === 'string') return candidate.text
    if (typeof candidate.value === 'string') return candidate.value
  }
  return String(output)
}

/** The slice of `ctx.shell` we consume (typed structurally: no host package needed). */
export interface ShellSeam {
  resolve(request: {
    command: string
    env?: Record<string, string>
    timeoutMs?: number
    onExpiry?: 'kill' | 'none'
    signal?: AbortSignal | undefined
  }): unknown
  execute(spec: unknown): Promise<{ result(): Promise<ShellRunResultLike> }>
}

export interface ShellRunResultLike {
  exitCode: number | null
  timedOut?: boolean
  aborted?: boolean
  stdout?: unknown
  stderr?: unknown
}

export interface UseResult {
  exitCode: number
  stdout: string
  stderr: string
  redacted: boolean
  injectedAs: string
}

/**
 * Run `argv` with `value` in the child environment only. Returns the redacted output; the
 * caller records the audit trail (this function writes nothing).
 */
export async function runWithCredential(
  shell: ShellSeam,
  input: { ref: string; argv: readonly string[]; value: string; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<UseResult> {
  const injectedAs = injectedName(input.ref)
  const spec = shell.resolve({
    command: toCommand(input.argv),
    env: { [injectedAs]: input.value },
    timeoutMs: input.timeoutMs,
    onExpiry: 'kill',
    signal: input.signal,
  })
  const handle = await shell.execute(spec)
  const result = await handle.result()

  const stdout = redact(textOf(result.stdout), input.value)
  const stderr = redact(textOf(result.stderr), input.value)
  const notes: string[] = []
  if (result.timedOut) notes.push(`timed out after ${input.timeoutMs}ms`)
  if (result.aborted) notes.push('aborted')
  const suffix = notes.length > 0 ? `\n(${notes.join('; ')})` : ''

  return {
    exitCode: result.exitCode ?? -1,
    stdout: stdout.text + suffix,
    stderr: stderr.text,
    redacted: stdout.hit || stderr.hit,
    injectedAs,
  }
}
