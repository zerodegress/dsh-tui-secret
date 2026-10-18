// The `dsh-tui-secret` CLI: the same secret operations for scripts and non-TTY use.
//
// The design premises (it coexists with the DSH credential provider rather than competing):
//   1. Writes follow the provider's own protocol: an exclusive `wx` lock on
//      `<credentials file>.lock` (two-second timeout), then a re-read inside the lock, then
//      `writeFileAtomic` (random-suffix sibling in the same directory plus rename, 0600/0700).
//      Protocol source: `@deepseek-ai/dsh-atomic-write/lib/index.js:30` (writeFileAtomic) and
//      `:72` (withFileLock — the lock path is simply `${filename}.lock`).
//   2. **Row-level upsert, never a whole-document parse and re-serialize**: only the rows the
//      target key occupies are rewritten, so other keys, comments, key order and block scalars
//      survive. The provider writes a block scalar (`KEY: |`) when a value contains a newline,
//      so "the rows of one key" run from its `KEY:` row to the next top-level key, including
//      indented continuation rows.
//   3. Reads need no lock: the provider commits by rename, so a reader sees either the old or
//      the new complete document.
//   4. Anything whose shape is uncertain is refused (nested mappings, duplicate keys), with an
//      error rather than a guess.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describeNameProblem, initialiseName, loadNames, saveNames } from './store.js'

export const USAGE = `dsh-tui-secret — manage credential references outside dsh-TUI (a value only ever reaches the credential store)

Usage:
  dsh-tui-secret list [--json] — names and state only, never a value
  dsh-tui-secret set <NAME> [source flags] — write or overwrite one value
  dsh-tui-secret rm <NAME> --yes — delete (refused without --yes)

Source (set needs exactly one; on a non-TTY, giving none fails):
  --from-stdin                              read the value from standard input (verbatim, no trim)
  --from-file <path>                        read the value from a file (verbatim)
  (on a TTY with no source flag: one no-echo prompt)

Other flags:
  --dsh-home <path>                         credential directory; defaults to $DSH_HOME, then ~/.dsh
  --dry-run                                 print what would happen, write nothing
  --json                                    JSON output for list
  -h, --help / -v, --version

Discipline:
  - a value never enters argv, is never echoed and is never logged; only the name and the byte count are reported.
  - an empty value is refused (it means unconfigured; use rm to delete).
  - names follow DSH rules: start with an uppercase letter, [A-Z0-9_], at most 64 characters; DEEPSEEK_ / DSH_ belong to the host.`

/** A refusal: reported on stderr and exiting with code 2 (distinct from a runtime failure, 1). */
export class UsageError extends Error {}

const LOCK_TIMEOUT_MS = 2000
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const GROUP_OTHER_BITS = 0o077

/** DSH's home rule: `--dsh-home` > `$DSH_HOME` (whitespace counts as unset) > `~/.dsh`. */
export function resolveDshHome(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return path.resolve(explicit)
  const fromEnv = env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

export function credentialsFile(dshHome: string): string {
  return path.join(dshHome, '.credentials.yaml')
}

// ------------------------------------------------------------------ row-level YAML editing
/** A top-level key row: `KEY: value`, with no leading indentation. */
const TOP_KEY = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/

/** Encode a value as one double-quoted YAML scalar: single-line, reversible, safe for any byte. */
export function encodeScalar(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += char
  }
  return `${out}"`
}

/** The rows one top-level key occupies, from its `KEY:` row up to (not including) the next. */
interface Span {
  key: string
  start: number
  end: number
  raw: string
}

interface Spans {
  spans: Map<string, Span>
  order: Span[]
  orphans: number[]
}

/**
 * Split a YAML document into per-key spans: from a `KEY:` row to the next top-level key (or
 * the end of the file). Blank rows and indented rows (the body of a block scalar) belong to
 * the key they follow.
 */
function spans(lines: string[]): Spans {
  const found = new Map<string, Span>()
  const order: Span[] = []
  const orphans: number[] = []
  let current: Span | null = null
  lines.forEach((line, index) => {
    if (line.trim() === '' && current === null) return
    const match = TOP_KEY.exec(line)
    if (match && !/^\s/.test(line)) {
      if (found.has(match[1])) throw new UsageError(`the credential document repeats the key ${match[1]}; this tool does not guess, please tidy the file first`)
      current = { key: match[1], start: index, end: index + 1, raw: match[2] }
      found.set(match[1], current)
      order.push(current)
      return
    }
    if (/^\s/.test(line)) {
      if (current === null) { orphans.push(index); return }
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*:/.test(line)) {
        throw new UsageError(`${current.key} holds a nested mapping; this tool only rewrites rows and refuses to touch it`)
      }
      current.end = index + 1
    }
  })
  return { spans: found, order, orphans }
}

function documentLines(text: string | undefined): string[] {
  if (text === undefined || text.trim() === '' || text.trim() === '{}') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Row-level upsert: returns the new text, rewriting only the target key's span. */
export function renderUpsert(text: string | undefined, ref: string, value: string): string {
  const suffix = `${ref}: ${encodeScalar(value)}`
  const lines = documentLines(text)
  const model = spans(lines)
  const existing = model.spans.get(ref)
  if (existing) {
    return [...lines.slice(0, existing.start), suffix, ...lines.slice(existing.end)].join('\n') + '\n'
  }
  return [...lines, suffix].join('\n') + '\n'
}

/** Row-level delete: the whole span goes; emptying the document leaves `{}`, as the provider does. */
export function renderDelete(text: string | undefined, ref: string): string {
  const lines = documentLines(text)
  const model = spans(lines)
  const existing = model.spans.get(ref)
  if (!existing) return text ?? ''
  const remaining = [...lines.slice(0, existing.start), ...lines.slice(existing.end)]
  // Emptied, this lands on `{}` like the provider; comments alone are kept (nothing of the
  // user's is thrown away).
  if (remaining.filter((line) => line.trim() !== '').length === 0) return '{}\n'
  return remaining.join('\n') + '\n'
}

/** One listed key: the name plus whether the document gives it a value. */
export interface ListedKey {
  name: string
  configured: boolean
}

/** Read-only key listing (a reader needs no lock: the provider commits by rename). */
export function readKeys(text: string | undefined): ListedKey[] {
  const lines = documentLines(text)
  const model = spans(lines)
  return model.order.map((span) => {
    const raw = span.raw.trim()
    const empty = raw === '' || raw === '""' || raw === "''" || raw === 'null' || raw === '~'
    return { name: span.key, configured: !empty }
  })
}

// ------------------------------------------------------------------ lock and atomic write
/**
 * The provider's own lock: `wx` on `${filename}.lock`, giving up with an error rather than
 * guessing whether the lock holder is still alive.
 */
export async function withWriterLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await fsp.writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
    if (Date.now() >= deadline) {
      throw new UsageError(`the writer lock (${lockPath}) has been held for more than ${LOCK_TIMEOUT_MS / 1000}s; another dsh / dsh-tui-secret is probably writing — retry shortly`)
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await fsp.rm(lockPath, { force: true })
  }
}

async function writeFileAtomic(filename: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temp, content, { mode: 0o600, flag: 'wx' })
    await fsp.rename(temp, filename)
  } catch (error) {
    await fsp.rm(temp, { force: true })
    throw error
  }
}

/** The provider's start-up check: a file readable beyond its owner is refused, with a chmod hint. */
export async function assertOwnerOnly(filename: string): Promise<void> {
  let stat
  try {
    stat = await fsp.stat(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
  if ((stat.mode & GROUP_OTHER_BITS) === 0) return
  throw new UsageError(`${filename} is readable beyond its owner (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 first`)
}

async function readTextIfPresent(filename: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
}

// ------------------------------------------------------------------ arguments
/** The parsed command line. */
export interface Flags {
  json: boolean
  dryRun: boolean
  yes: boolean
  fromStdin: boolean
  fromFile: string | undefined
  dshHome: string | undefined
  help: boolean
  version: boolean
}

export function parseArgs(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = { json: false, dryRun: false, yes: false, fromStdin: false, fromFile: undefined, dshHome: undefined, help: false, version: false }
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') flags.json = true
    else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--yes' || arg === '-y') flags.yes = true
    else if (arg === '--from-stdin') flags.fromStdin = true
    else if (arg === '--from-file') {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError('--from-file needs a path')
      flags.fromFile = next
      index += 1
    } else if (arg === '--dsh-home') {
      const next = argv[index + 1]
      if (next === undefined) throw new UsageError('--dsh-home needs a path')
      flags.dshHome = next
      index += 1
    } else if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '-v' || arg === '--version') flags.version = true
    else if (arg.startsWith('-')) throw new UsageError(`unknown flag: ${arg}`)
    else positionals.push(arg)
  }
  return { flags, positionals }
}

/** The process boundaries the CLI needs; tests replace them (a value never crosses `out`). */
export interface Io {
  env: NodeJS.ProcessEnv
  stdinIsTty(): boolean
  out(text: string): void
  err(text: string): void
  readAllStdin(): Promise<Buffer>
  promptHidden(label: string): Promise<Buffer>
}

async function readValue(flags: Flags, io: Io): Promise<Buffer> {
  if (flags.fromFile !== undefined) return await fsp.readFile(flags.fromFile)
  if (flags.fromStdin) return await io.readAllStdin()
  if (!io.stdinIsTty()) {
    throw new UsageError('standard input is not a terminal: pass --from-stdin or --from-file <path> explicitly; without a source nothing is written')
  }
  return await io.promptHidden('Value (not echoed, Enter to finish, Ctrl-C to abort): ')
}

// ------------------------------------------------------------------ subcommands
/** One `list` row. */
interface Row {
  name: string
  state: string
  source: string
  shadowed: boolean
}

async function commandList(flags: Flags, io: Io): Promise<number> {
  const home = resolveDshHome(flags.dshHome, io.env)
  const file = credentialsFile(home)
  const text = await readTextIfPresent(file)
  const stored = text === undefined ? [] : readKeys(text)
  const storedNames = new Set(stored.map((entry) => entry.name))
  const rows: Row[] = stored.map((entry) => ({
    name: entry.name,
    state: entry.configured ? 'configured' : 'empty (equals unconfigured)',
    source: path.basename(file),
    shadowed: Boolean(io.env[entry.name]),
  }))
  for (const name of loadNames(io.env)) {
    if (!storedNames.has(name)) rows.push({ name, state: 'not configured', source: 'name index only', shadowed: Boolean(io.env[name]) })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))

  if (flags.json) {
    io.out(JSON.stringify(rows.map(({ name, state, source, shadowed }) => ({ name, state, source, shadowed })), null, 2) + '\n')
    return 0
  }
  if (rows.length === 0) {
    io.out(`No recorded references (${file} does not exist or is empty).\n`)
    return 0
  }
  for (const row of rows) {
    io.out(`${row.name.padEnd(24)} ${row.state}${row.shadowed ? ' · shadowed by the process environment (read-only)' : ''}\n`)
  }
  return 0
}

async function commandSet(name: string, flags: Flags, io: Io): Promise<number> {
  const ref = initialiseName(name)
  const problem = describeNameProblem(ref)
  if (problem) throw new UsageError(problem)
  if (io.env[ref] !== undefined && io.env[ref] !== '') {
    throw new UsageError(`${ref} is already set in this process environment, which outranks the credential file — the write would be shadowed into an apparent success. Unset it first`)
  }
  const bytes = await readValue(flags, io)
  const value = bytes.toString('utf8')
  if (value.length === 0) throw new UsageError('the value is empty; an empty value means unconfigured — use rm to clear the reference')

  const home = resolveDshHome(flags.dshHome, io.env)
  const file = credentialsFile(home)
  if (flags.dryRun) {
    io.out(`[dry-run] would write ${ref} into ${file} (${bytes.length} bytes, value not echoed)\n`)
    return 0
  }
  await assertOwnerOnly(file)
  await withWriterLock(file, async () => {
    // Re-read inside the lock: content another writer just committed must not be lost.
    const text = await readTextIfPresent(file)
    const next = renderUpsert(text, ref, value)
    await writeFileAtomic(file, next)
  })
  const names = loadNames(io.env)
  if (!names.includes(ref)) saveNames([...names, ref], io.env)
  io.out(`${ref} written (${bytes.length} bytes, value not echoed)\n`)
  return 0
}

async function commandRm(name: string, flags: Flags, io: Io): Promise<number> {
  const ref = initialiseName(name)
  if (!ref) throw new UsageError('rm needs a name')
  const home = resolveDshHome(flags.dshHome, io.env)
  const file = credentialsFile(home)
  if (!flags.yes) {
    throw new UsageError(`deleting ${ref} needs an explicit --yes (this cannot be undone)`)
  }
  if (flags.dryRun) {
    io.out(`[dry-run] would delete ${ref} from ${file}\n`)
    return 0
  }
  await assertOwnerOnly(file)
  await withWriterLock(file, async () => {
    const text = await readTextIfPresent(file)
    if (text === undefined) return
    const next = renderDelete(text, ref)
    if (next === text) return
    await writeFileAtomic(file, next)
  })
  saveNames(loadNames(io.env).filter((entry) => entry !== ref), io.env)
  io.out(`${ref} deleted\n`)
  return 0
}

// ------------------------------------------------------------------ entry point
export async function run(argv: string[], io: Io): Promise<number> {
  const { flags, positionals } = parseArgs(argv)
  if (flags.help || positionals.length === 0) {
    io.out(`${USAGE}\n`)
    return flags.help ? 0 : 2
  }
  if (flags.version) {
    io.out('dsh-tui-secret 0.1.0\n')
    return 0
  }
  const [command, ...rest] = positionals
  if (command === 'list') return await commandList(flags, io)
  if (command === 'set') {
    if (rest.length !== 1) throw new UsageError('set needs exactly one name')
    return await commandSet(rest[0] as string, flags, io)
  }
  if (command === 'rm' || command === 'remove' || command === 'delete') {
    if (rest.length !== 1) throw new UsageError('rm needs exactly one name')
    return await commandRm(rest[0] as string, flags, io)
  }
  throw new UsageError(`unknown subcommand: ${command}`)
}

/** The real process adapter (bin and tests both go through it; tests can replace stdinIsTty/readAllStdin). */
export function processIo(): Io {
  return {
    env: process.env,
    stdinIsTty: () => Boolean(process.stdin.isTTY),
    out: (text: string) => process.stdout.write(text),
    err: (text: string) => process.stderr.write(text),
    readAllStdin: async (): Promise<Buffer> => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    },
    promptHidden: async (label: string): Promise<Buffer> => {
      if (typeof process.stdin.setRawMode !== 'function') {
        throw new UsageError('this terminal cannot do no-echo input; use --from-stdin or --from-file instead')
      }
      process.stderr.write(label)
      const previous = process.stdin.isRaw
      process.stdin.setRawMode(true)
      process.stdin.resume()
      const buffer: number[] = []
      try {
        for await (const chunk of process.stdin) {
          for (const byte of chunk as Buffer) {
            if (byte === 0x03) { process.stderr.write('\n'); throw new UsageError('aborted (Ctrl-C)') }
            if (byte === 0x0d || byte === 0x0a) {
              process.stderr.write('\n')
              return Buffer.from(buffer)
            }
            if (byte === 0x7f) { buffer.pop(); continue }
            buffer.push(byte)
          }
        }
      } finally {
        if (previous !== undefined) process.stdin.setRawMode(Boolean(previous))
        process.stdin.pause()
      }
      process.stderr.write('\n')
      return Buffer.from(buffer)
    },
  }
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  try {
    return await run(argv, io)
  } catch (error) {
    const label = error instanceof UsageError ? 'refused' : 'failed'
    io.err(`${label}: ${(error as Error)?.message ?? String(error)}\n`)
    return error instanceof UsageError ? 2 : 1
  }
}

/**
 * For tests: the row editor's internals, so a refusal can be asserted without a file.
 * @internal
 */
export const __testing = { spans, documentLines, writeFileAtomic }
