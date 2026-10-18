// The reference-name index: it records which reference names exist, never a value.
//
// It lives under the existing `~/.dsh-tui` home (the ecosystem keeps user data in
// established locations) and never touches `.credentials.yaml` itself — a value is
// only ever written through `ctx.credentials`. This module therefore imports no DSH
// package and can be tested on its own.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Credential reference syntax, matching the check in api-settings-controller. */
export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * Reference prefixes owned by the host. dsh-TUI's `credentialRefGuard` drops
 * `DEEPSEEK_*` / `DSH_` on the settings-section path; we check first so the user gets a
 * readable reason instead of a silent drop by the host.
 */
export const RESERVED_PREFIXES = ['DEEPSEEK_', 'DSH_']

export function initialiseName(name) {
  return String(name ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
}

export function describeNameProblem(name) {
  if (!name) return 'the name is empty'
  if (!NAME_PATTERN.test(name)) return 'a name starts with a letter and holds only A-Z, 0-9 and _, at most 64 characters'
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `names starting with ${RESERVED_PREFIXES.join(' / ')} belong to the host; pick another one (for example BILI_COOKIE)`
  }
  return undefined
}

function baseDir(env = process.env) {
  const home = env.DSH_TUI_HOME || path.join(os.homedir(), '.dsh-tui')
  return path.join(home, 'dsh-tui-secret')
}

export function namesFile(env = process.env) {
  return path.join(baseDir(env), 'refs.json')
}

/** Read the name index; a missing or damaged file reads as empty — a damaged file is never overwritten. */
export function loadNames(env = process.env) {
  const file = namesFile(env)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text)
    const names = Array.isArray(parsed?.names) ? parsed.names : []
    return names.filter((n) => typeof n === 'string' && NAME_PATTERN.test(n))
  } catch (error) {
    return []
  }
}

/** Atomic write (same-directory temporary file plus rename, 0600), as DSH itself does. */
export function saveNames(names, env = process.env) {
  const file = namesFile(env)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const payload = JSON.stringify({ version: 1, names: [...new Set(names)].sort() }, null, 2) + '\n'
  const tmp = path.join(dir, `.refs.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, payload, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

export function addName(name, env = process.env) {
  const names = loadNames(env)
  if (!names.includes(name)) names.push(name)
  saveNames(names, env)
  return names
}

export function removeName(name, env = process.env) {
  const names = loadNames(env).filter((n) => n !== name)
  saveNames(names, env)
  return names
}
