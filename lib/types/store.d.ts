/** Credential reference syntax, matching the check in api-settings-controller. */
export declare const NAME_PATTERN: RegExp;
/**
 * Reference prefixes owned by the host. dsh-TUI's `credentialRefGuard` drops
 * `DEEPSEEK_*` / `DSH_` on the settings-section path; we check first so the user gets a
 * readable reason instead of a silent drop by the host.
 */
export declare const RESERVED_PREFIXES: string[];
/** How far an agent may use a reference, decided by the human on the card. */
export type Scope = 'none' | 'once' | 'session' | 'until';
export interface RefRecord {
    ref: string;
    /** What the agent said it needs it for; shown to the human, kept in the record. */
    purpose?: string;
    status: 'stored' | 'refused' | 'cancelled';
    scope: Scope;
    requestedAt?: string;
    /** The session that asked (Branded SessionId at runtime); the judge for `scope: session`. */
    sessionId?: string;
    storedAt?: string;
    expiresAt?: string | null;
    useCount: number;
    lastUsedAt?: string | null;
    revokedAt?: string | null;
}
export type AuditEvent = 'request' | 'stored' | 'refused' | 'cancelled' | 'used' | 'redacted' | 'revoked' | 'expired' | 'deleted';
export interface AuditEntry {
    event: AuditEvent;
    ref: string;
    purpose?: string;
    sessionId?: string;
    exitCode?: number;
}
/** Why a use is refused; every branch is a premise that was missing. */
export type Denial = 'no-record' | 'not-stored' | 'scope-none' | 'once-used' | 'expired' | 'revoked' | 'wrong-session';
/** Turn whatever the user typed into the canonical reference name. */
export declare function initialiseName(name: unknown): string;
/** The readable reason a name is refused, or undefined when the name is usable. */
export declare function describeNameProblem(name: string | undefined): string | undefined;
/** The record file for this environment. */
export declare function namesFile(env?: NodeJS.ProcessEnv): string;
/** The audit file for this environment. */
export declare function auditFile(env?: NodeJS.ProcessEnv): string;
/** Read the records; a missing or damaged file reads as empty — a damaged file is never overwritten. */
export declare function loadRecords(env?: NodeJS.ProcessEnv): RefRecord[];
/** Atomic write (same-directory temporary file plus rename, 0600), as DSH itself does. */
export declare function saveRecords(records: readonly RefRecord[], env?: NodeJS.ProcessEnv): string;
/** One line per event; append-only, 0600, names and outcomes only — never a value. */
export declare function appendAudit(entry: AuditEntry, env?: NodeJS.ProcessEnv): void;
/** Insert or update one record, leaving every other record untouched. */
export declare function upsertRecord(ref: string, patch: Partial<RefRecord>, env?: NodeJS.ProcessEnv): RefRecord;
/** The human said yes: remember the value is stored, and how far the agent may use it. */
export declare function markStored(ref: string, decision: {
    scope: Scope;
    purpose?: string;
    sessionId?: string;
    expiresAt?: string | null;
}, env?: NodeJS.ProcessEnv): RefRecord;
/** The human said no (or cancelled): record the outcome, store nothing. */
export declare function markRefused(ref: string, status: 'refused' | 'cancelled', purpose: string | undefined, sessionId: string | undefined, env?: NodeJS.ProcessEnv): void;
/** Count a use and stamp it — the value the tool actually used never lands here. */
export declare function markUsed(ref: string, env?: NodeJS.ProcessEnv): RefRecord | undefined;
/** Revoke one reference's permission (the value stays in the credential store). */
export declare function revoke(ref: string, env?: NodeJS.ProcessEnv): boolean;
/** Revoke every live permission; values stay where they are. Returns what was revoked. */
export declare function revokeAll(env?: NodeJS.ProcessEnv): string[];
/** Delete a reference record (the human's delete action removes the credential too, elsewhere). */
export declare function removeRecord(ref: string, env?: NodeJS.ProcessEnv): RefRecord[];
/**
 * The one judge for "may this call use the value": every scope is decided here, at the tool
 * entry, from the record plus the caller's session id — no lifecycle hooks involved.
 */
export declare function authorised(ref: string, sessionId: string | undefined, env?: NodeJS.ProcessEnv, now?: number): {
    ok: true;
    record: RefRecord;
} | {
    ok: false;
    why: Denial;
};
/** The live names (v1 shape), for the scene's list and the older assertions. */
export declare function loadNames(env?: NodeJS.ProcessEnv): string[];
/** Keep the v1 writers working: they only ever add or drop a name, with no permission. */
export declare function saveNames(names: readonly string[], env?: NodeJS.ProcessEnv): string;
export declare function addName(name: string, env?: NodeJS.ProcessEnv): string[];
export declare function removeName(name: string, env?: NodeJS.ProcessEnv): string[];
