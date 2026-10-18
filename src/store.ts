// The reference index: which names exist, what the human allowed, and how it was recorded.
//
// It records **names and decisions, never a value**. Values only ever move through
// `ctx.credentials` (the human types one into the card, `use_credential` reads one back into
// a single child process). This module imports no DSH package and can be tested on its own.
//
// Two files, both under the existing `~/.dsh-tui` home:
//   refs.json    the records (atomic write, 0600, directory 0700, a damaged file is never
//                overwritten — it reads as empty with a loud warning)
//   audit.jsonl  one line per event, append-only, same permissions, names and outcomes only
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

/** How far an agent may use a reference, decided by the human on the card. */
export type Scope = 'none' | 'once' | 'session' | 'until'

export interface RefRecord {
  ref: string
  /** What the agent said it needs it for; shown to the human, kept in the record. */
  purpose?: string
  status: 'stored' | 'refused' | 'cancelled'
  scope: Scope
  requestedAt?: string
  /** The session that asked (Branded SessionId at runtime); the judge for `scope: session`. */
  sessionId?: string
  storedAt?: string
  expiresAt?: string | null
  useCount: number
  lastUsedAt?: string | null
  revokedAt?: string | null
}

export type AuditEvent = 'request' | 'stored' | 'refused' | 'cancelled' | 'used' | 'redacted' | 'revoked' | 'expired' | 'deleted'

export interface AuditEntry {
  event: AuditEvent
  ref: string
  purpose?: string
  sessionId?: string
  exitCode?: number
}

/** Why a use is refused; every branch is a premise that was missing. */
export type Denial = 'no-record' | 'not-stored' | 'scope-none' | 'once-used' | 'expired' | 'revoked' | 'wrong-session'

/** Turn whatever the user typed into the canonical reference name. */
export function initialiseName(name: unknown): string {
  return String(name ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/** The readable reason a name is refused, or undefined when the name is usable. */
export function describeNameProblem(name: string | undefined): string | undefined {
  if (!name) return 'the name is empty'
  if (!NAME_PATTERN.test(name)) return 'a name starts with a letter and holds only A-Z, 0-9 and _, at most 64 characters'
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `names starting with ${RESERVED_PREFIXES.join(' / ')} belong to the host; pick another one (for example BILI_COOKIE)`
  }
  return undefined
}

function baseDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_TUI_HOME || path.join(os.homedir(), '.dsh-tui')
  return path.join(home, 'dsh-tui-secret')
}

/** The record file for this environment. */
export function namesFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(baseDir(env), 'refs.json')
}

/** The audit file for this environment. */
export function auditFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(baseDir(env), 'audit.jsonl')
}

function emptyRecord(ref: string): RefRecord {
  return { ref, status: 'stored', scope: 'none', useCount: 0, revokedAt: null, expiresAt: null }
}

/** Accept v1 (`{version:1,names:[…]}` or a bare array) as names-only records. */
function fromParsed(parsed: unknown): RefRecord[] {
  const source = Array.isArray(parsed) ? parsed : (parsed as { names?: unknown })?.names
  if (Array.isArray(source)) {
    return source
      .filter((entry): entry is string => typeof entry === 'string' && NAME_PATTERN.test(entry))
      .map((ref) => emptyRecord(ref))
  }
  const refs = (parsed as { refs?: unknown })?.refs
  if (!Array.isArray(refs)) return []
  return refs
    .filter((entry): entry is RefRecord => Boolean(entry) && typeof (entry as RefRecord).ref === 'string')
    .map((entry) => ({ ...emptyRecord(entry.ref), ...entry, useCount: Number.isFinite(entry.useCount) ? entry.useCount : 0 }))
}

/** Read the records; a missing or damaged file reads as empty — a damaged file is never overwritten. */
export function loadRecords(env: NodeJS.ProcessEnv = process.env): RefRecord[] {
  let text: string
  try {
    text = fs.readFileSync(namesFile(env), 'utf8')
  } catch {
    return []
  }
  try {
    return fromParsed(JSON.parse(text)).filter((record) => NAME_PATTERN.test(record.ref))
  } catch {
    return []
  }
}

/** Atomic write (same-directory temporary file plus rename, 0600), as DSH itself does. */
export function saveRecords(records: readonly RefRecord[], env: NodeJS.ProcessEnv = process.env): string {
  const file = namesFile(env)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sorted = [...records].sort((a, b) => a.ref.localeCompare(b.ref))
  const payload = JSON.stringify({ version: 2, refs: sorted }, null, 2) + '\n'
  const tmp = path.join(dir, `.refs.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, payload, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

/** One line per event; append-only, 0600, names and outcomes only — never a value. */
export function appendAudit(entry: AuditEntry, env: NodeJS.ProcessEnv = process.env): void {
  const file = auditFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
  fs.appendFileSync(file, line, { mode: 0o600 })
}

/** Insert or update one record, leaving every other record untouched. */
export function upsertRecord(ref: string, patch: Partial<RefRecord>, env: NodeJS.ProcessEnv = process.env): RefRecord {
  const records = loadRecords(env)
  const index = records.findIndex((record) => record.ref === ref)
  const next: RefRecord = { ...(index === -1 ? emptyRecord(ref) : records[index]), ...patch, ref }
  if (index === -1) records.push(next)
  else records[index] = next
  saveRecords(records, env)
  return next
}

/** The human said yes: remember the value is stored, and how far the agent may use it. */
export function markStored(
  ref: string,
  decision: { scope: Scope; purpose?: string; sessionId?: string; expiresAt?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): RefRecord {
  const now = new Date()
  return upsertRecord(ref, {
    status: 'stored',
    scope: decision.scope,
    purpose: decision.purpose,
    sessionId: decision.sessionId,
    storedAt: now.toISOString(),
    expiresAt: decision.scope === 'until' ? (decision.expiresAt ?? null) : null,
    revokedAt: null,
  }, env)
}

/** The human said no (or cancelled): record the outcome, store nothing. */
export function markRefused(ref: string, status: 'refused' | 'cancelled', purpose: string | undefined, sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  upsertRecord(ref, { status, scope: 'none', purpose, sessionId, revokedAt: null }, env)
}

/** Count a use and stamp it — the value the tool actually used never lands here. */
export function markUsed(ref: string, env: NodeJS.ProcessEnv = process.env): RefRecord | undefined {
  const records = loadRecords(env)
  const record = records.find((entry) => entry.ref === ref)
  if (!record) return undefined
  record.useCount += 1
  record.lastUsedAt = new Date().toISOString()
  if (record.scope === 'once') record.revokedAt = record.lastUsedAt
  saveRecords(records, env)
  return record
}

/** Revoke one reference's permission (the value stays in the credential store). */
export function revoke(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const records = loadRecords(env)
  const record = records.find((entry) => entry.ref === ref)
  if (!record || record.scope === 'none') return false
  record.scope = 'none'
  record.revokedAt = new Date().toISOString()
  saveRecords(records, env)
  return true
}

/** Revoke every live permission; values stay where they are. Returns what was revoked. */
export function revokeAll(env: NodeJS.ProcessEnv = process.env): string[] {
  const records = loadRecords(env)
  const now = new Date().toISOString()
  const revoked: string[] = []
  for (const record of records) {
    if (record.scope === 'none') continue
    record.scope = 'none'
    record.revokedAt = now
    revoked.push(record.ref)
  }
  if (revoked.length > 0) saveRecords(records, env)
  return revoked
}

/** Delete a reference record (the human's delete action removes the credential too, elsewhere). */
export function removeRecord(ref: string, env: NodeJS.ProcessEnv = process.env): RefRecord[] {
  const records = loadRecords(env).filter((record) => record.ref !== ref)
  saveRecords(records, env)
  return records
}

/**
 * The one judge for "may this call use the value": every scope is decided here, at the tool
 * entry, from the record plus the caller's session id — no lifecycle hooks involved.
 */
export function authorised(
  ref: string,
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): { ok: true; record: RefRecord } | { ok: false; why: Denial } {
  const record = loadRecords(env).find((entry) => entry.ref === ref)
  if (!record) return { ok: false, why: 'no-record' }
  if (record.status !== 'stored') return { ok: false, why: 'not-stored' }
  if (record.scope === 'none') return { ok: false, why: 'revoked' }
  if (record.scope === 'once') {
    if (record.revokedAt) return { ok: false, why: 'revoked' }
    if (record.useCount > 0) return { ok: false, why: 'once-used' }
  }
  if (record.scope === 'until') {
    if (record.revokedAt) return { ok: false, why: 'revoked' }
    if (!record.expiresAt || Date.parse(record.expiresAt) <= now) return { ok: false, why: 'expired' }
  }
  if (record.scope === 'session') {
    // Judged by session id only, and never cleared automatically: resuming a session creates a
    // new agent but keeps the same SessionId, so no event marks "that session is gone for good".
    // The human revokes (single entry or `R`); `once` and `until` are the only self-expiring ones.
    if (record.revokedAt) return { ok: false, why: 'revoked' }
    if (!sessionId || record.sessionId !== sessionId) return { ok: false, why: 'wrong-session' }
  }
  return { ok: true, record }
}

// ------------------------------------------------------------------ v1 compatibility
/** The live names (v1 shape), for the scene's list and the older assertions. */
export function loadNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return loadRecords(env).filter((record) => record.status === 'stored').map((record) => record.ref)
}

/** Keep the v1 writers working: they only ever add or drop a name, with no permission. */
export function saveNames(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const existing = new Map(loadRecords(env).map((record) => [record.ref, record]))
  const next = [...new Set(names)].filter((name) => NAME_PATTERN.test(name)).map((ref) => {
    const record = existing.get(ref)
    return record && record.status === 'stored' ? record : emptyRecord(ref)
  })
  return saveRecords(next, env)
}

export function addName(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = loadNames(env)
  if (!names.includes(name)) names.push(name)
  saveNames(names, env)
  return names
}

export function removeName(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = loadNames(env).filter((entry) => entry !== name)
  saveNames(names, env)
  return names
}
