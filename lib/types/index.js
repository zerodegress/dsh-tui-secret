// dsh-tui-secret — the agent asks, the human answers, and the value never travels back.
//
// Plugin contract (tui-profile plugin guide, "plugin contract"):
//   - the package root exports `name` / `apply`, with no default export;
//   - every configuration key has a default, and a missing service degrades silently —
//     the TUI must always start;
//   - resources are released through ctx.effect(() => () => dispose()).
//
// What this plugin is (0.2.0): two model-facing tools and no CLI.
//   request_credential(ref, purpose) — the agent asks; the human gets a masked card; the value
//     goes straight into the DSH credential store; the tool returns only a status.
//   use_credential(ref, argv) — run one command with the value present in exactly one child
//     process (never in the agent's own environment), then return output with the value
//     replaced by `[credential]`. Every scope (none / once / session / until) is enforced here,
//     at the tool entry, because this tool is the only way the agent can use a value.
//
// The two card seams this plugin uses, and why:
//   - tuiScenes renders the `/secrets` scene: list + manual entry + the request card.
//   - credentials (a DSH core service) is the only place a value is written or read.
// Everything else is optional and probed with `ctx.get(name, false)`, so a missing seam can
// never keep the TUI from starting.
//
// The host seams below are typed structurally on purpose: this package declares only the little
// it consumes, so a host release that changes an unrelated part of `Context` does not break the
// build here (and no host type package is needed to compile).
import { describeNameProblem, initialiseName, loadNames, addName, removeName, loadRecords, markStored, markUsed, appendAudit, authorised, revoke, revokeAll } from './store.js';
import { SceneChannel, RefusingChannel } from './card.js';
import { runWithCredential } from './use.js';
export const name = 'dsh-tui-secret';
/** Scene id: kebab-case, globally unique. */
const SCENE_ID = 'secrets';
/** The two model-facing tools; these names are the model's whole vocabulary here. */
const REQUEST_TOOL = 'request_credential';
const USE_TOOL = 'use_credential';
/** `use_credential` defaults (the executor may cap the timeout further). */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
/** Exported for tests and documentation: the defaults this plugin declares. */
export const DEFAULTS = {
    /** Slash-command name that opens the scene, without the slash. */
    entryCommand: 'secrets',
    /** Scene title, for logs and debugging; the scene draws its own header. */
    title: 'Secrets',
    /** One `•` per character: the conventional password look. `none` is the strict alternative. */
    echo: 'dots',
};
/** How the four scopes read on the screen. */
const SCOPE_LABEL = {
    none: 'agent use not allowed',
    once: 'agent may use it once',
    session: 'agent may use it in this session',
    until: 'agent may use it until it expires',
};
/** The scopes the card offers: `session` only when we actually know the session id. */
function offeredScopes(sessionId) {
    return sessionId ? ['none', 'once', 'session', 'until'] : ['none', 'once', 'until'];
}
/** The error label used in notices and logs: code/name only, because raw text may embed a value. */
function failureLabel(error) {
    const failure = error;
    return String(failure?.code || failure?.name || 'unknown');
}
/**
 * `DSH_TUI_SECRET_DEBUG=1` adds the concrete reason to a refusal note ("the host did not open the
 * scene", "the card was answered with refuse", …); the default wording is unchanged. Read per call,
 * so a debug session can flip it without a restart. A reason never carries a value: the channel
 * keeps reason codes only.
 */
function debugReasons() {
    return process.env.DSH_TUI_SECRET_DEBUG === '1';
}
/**
 * The note a model sees when `request_credential` stored nothing. `refused` keeps its default
 * wording (the human's refusal and a card that could not be shown stay indistinguishable unless
 * debug is on); `cancelled` carries a note only in debug mode.
 */
function noCardNote(channel, kind) {
    if (kind === 'stored')
        return undefined;
    if (kind === 'cancelled')
        return debugReasons() ? `the request was cancelled [${channel.lastRefusal() ?? 'no reason recorded'}]` : undefined;
    const base = 'the user refused, or no card could be shown';
    return debugReasons() ? `${base} [${channel.lastRefusal() ?? 'no reason recorded'}]` : base;
}
/** The tool result a model sees: a status, never a value. */
function text(value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
/**
 * Plugin entry. Registers the scene, the slash command and the two model-facing tools; every
 * resource is disposed on the fibre that called apply.
 *
 * @param ctx - the Cordis context.
 * @param config - from cordis.patch.yml.
 */
export function apply(ctx, config) {
    const options = { ...DEFAULTS, ...(config ?? {}) };
    // A config file can carry any scalar; an unknown echo mode must fall back to the safe default
    // instead of rendering something we did not define.
    const echo = options.echo === 'none' ? 'none' : 'dots';
    const seams = ctx;
    const store = {
        loadNames: () => loadNames(),
        addName: (n) => addName(n),
        removeName: (n) => removeName(n),
    };
    const logger = {
        // Names and outcomes only, never a value; errors carry code/name because raw error
        // text may embed the value.
        info: (message) => seams.logger?.info?.(`[dsh-tui-secret] ${message}`),
        warn: (message) => seams.logger?.warn?.(`[dsh-tui-secret] ${message}`),
    };
    // Resolved per use rather than remembered: credentials is another plugin's service and
    // may be mounted after this apply runs.
    const getCredentials = () => seams.get('credentials', false) ?? seams.credentials;
    const getShell = () => seams.get('shell', false) ?? seams.shell;
    // The scene is registered on first use, never during `apply` and never inside an inject callback.
    // dsh-TUI's `tuiScenes` accepts a call only from an activation its fiber instrumentation has
    // already recorded. Neither place qualifies: `apply` still runs while the fiber is loading, and a
    // `ctx.inject()` callback runs under the child's ambient activation while this registration goes
    // through the parent ctx. Both throw
    //   "dsh-tui: tuiScenes.register requires a live Cordis activation context".
    // The command handler and the card run later, on our own activation, so they register the scene
    // first and open it immediately. `sceneFailure` keeps why a registration/open did not happen — a
    // silent failure is what made `/secrets` report "not registered" with no way to tell why.
    let sceneRegistered = false;
    let sceneFailure;
    const ensureScene = () => {
        const scenes = seams.get('tuiScenes', false);
        if (!scenes?.register) {
            sceneFailure = { stage: 'registration', code: 'noregister' };
            return undefined;
        }
        if (sceneRegistered)
            return scenes;
        try {
            const dispose = scenes.register({ id: SCENE_ID, title: options.title, component: scene }, ctx);
            seams.effect(() => () => dispose());
            sceneRegistered = true;
            sceneFailure = undefined;
            logger.info(`scene ${SCENE_ID} registered on first use`);
        }
        catch (error) {
            // Code/name only: an error's raw text may embed anything, and this line goes to the TUI log.
            sceneFailure = { stage: 'registration', code: failureLabel(error) };
            logger.warn(`scene registration failed (${sceneFailure.code}); /secrets cannot open`);
            return undefined;
        }
        return scenes;
    };
    /** Register (once) and open the scene. A false return always leaves a reason in `sceneFailure`. */
    const openScene = () => {
        const scenes = ensureScene();
        if (!scenes?.open)
            return false;
        try {
            return scenes.open(SCENE_ID);
        }
        catch (error) {
            sceneFailure = { stage: 'open', code: failureLabel(error) };
            logger.warn(`scene open failed (${sceneFailure.code})`);
            return false;
        }
    };
    // The card: our own scene is both the renderer and the answer path (design §2.2).
    const channel = new SceneChannel({ open: (id) => id === SCENE_ID && openScene() }, SCENE_ID, logger);
    const scene = makeScene({
        getCredentials,
        store,
        logger,
        channel,
        echo,
        records: () => loadRecords(),
        revokeGrant: (ref) => revoke(ref),
        revokeEveryGrant: () => revokeAll(),
    });
    seams.inject(['commands'], (commandCtx) => {
        const definition = {
            name: options.entryCommand,
            description: 'Enter, list or delete secrets (values are never echoed and never reach the conversation)',
            handler: () => {
                const scenes = seams.get('tuiScenes', false);
                if (!scenes?.open) {
                    return { kind: 'error', text: 'dsh-TUI provides no scene surface (tuiScenes), so /secrets cannot open' };
                }
                // Registering happens here, on this activation, not in apply: see `ensureScene`.
                if (openScene())
                    return { kind: 'success' };
                // The reason is for the human who typed the command, so it is always shown; it is a short
                // code — never an error's raw text, which may embed anything.
                const why = sceneFailure
                    ? `${sceneFailure.stage} failed: ${sceneFailure.code}`
                    : 'the host does not have it in the scene registry';
                return { kind: 'error', text: `the secrets scene is not registered (${why})` };
            },
        };
        let dispose;
        const host = seams.get('tuiPluginHost', false);
        if (host?.registerCommand) {
            try {
                dispose = host.registerCommand(ctx, definition);
                logger.info(`command ${options.entryCommand} registered (attributed)`);
            }
            catch (error) {
                logger.warn(`attributed registration failed (${failureLabel(error)}), falling back`);
            }
        }
        if (!dispose) {
            dispose = commandCtx.commands.register(definition);
            logger.info(`command ${options.entryCommand} registered (unattributed)`);
        }
        seams.effect(() => () => dispose());
    });
    registerTools({ seams, logger, channel, getCredentials, getShell });
}
/** Register both tools if the host has a tool registry (it may mount after this apply runs). */
function registerTools(deps) {
    const { seams, logger } = deps;
    const register = (definition) => {
        const tools = seams.get('tools', false);
        if (!tools?.register) {
            logger.warn(`no tools seam: ${definition.name} is not registered and the agent cannot call it`);
            return;
        }
        const dispose = tools.register(definition);
        seams.effect(() => () => dispose());
        logger.info(`tool ${definition.name} registered`);
    };
    register(requestCredentialTool(deps));
    register(useCredentialTool(deps));
}
/** `request_credential`: the agent asks, the human decides; only a status goes back. */
function requestCredentialTool(deps) {
    return {
        name: REQUEST_TOOL,
        description: 'Ask the user for a credential (by name) and store it. The user sees a masked card; the value goes straight into the credential store and is never returned to you. Returns only stored, cancelled or refused.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'purpose'],
            properties: {
                ref: { type: 'string', description: 'Credential name, e.g. ALPHA_TOKEN (uppercase letters, digits, underscore).' },
                purpose: { type: 'string', description: 'What you need it for, shown to the user on the card.' },
            },
        },
        output: {
            schema: {
                type: 'object',
                required: ['status', 'ref'],
                properties: { status: { type: 'string' }, ref: { type: 'string' }, note: { type: 'string' } },
            },
            render: (_args, value) => text(value),
        },
        execute: async (rawArgs, exec) => {
            const args = (rawArgs ?? {});
            const ref = initialiseName(args.ref);
            const problem = describeNameProblem(ref);
            if (problem)
                return { status: 'refused', ref, note: problem };
            const purpose = String(args.purpose ?? '').slice(0, 200);
            if (purpose === '')
                return { status: 'refused', ref, note: 'purpose is required' };
            const sessionId = exec?.agent?.id;
            const outcome = await deps.channel.request({ ref, purpose, sessionId }, { signal: exec?.signal });
            if (outcome.kind !== 'stored') {
                // A refusal or a cancellation writes nothing at all — no record, no audit line.
                deps.logger.info(`${REQUEST_TOOL} ${ref}: ${outcome.kind}`);
                // Omit `note` instead of setting it to undefined: the host rejects any tool result that is
                // not losslessly JSON, and an own property holding `undefined` is exactly that.
                const note = noCardNote(deps.channel, outcome.kind);
                return note === undefined ? { status: outcome.kind, ref } : { status: outcome.kind, ref, note };
            }
            markStored(ref, { scope: outcome.scope, purpose, sessionId });
            appendAudit({ event: 'request', ref, purpose, sessionId });
            appendAudit({ event: 'stored', ref, purpose, sessionId });
            deps.logger.info(`${REQUEST_TOOL} ${ref}: stored (${outcome.scope})`);
            return { status: 'stored', ref };
        },
    };
}
/** `use_credential`: run one command with the value in that child process only. */
function useCredentialTool(deps) {
    return {
        name: USE_TOOL,
        description: 'Run one command with a stored credential available in that child process only (the environment variable named in injectedAs). The credential never enters your own shell. Any occurrence of its value in the returned output is replaced with [credential] — that covers the returned slice, not a truncated or transformed copy, so do not echo the variable to read it.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'argv'],
            properties: {
                ref: { type: 'string', description: 'Credential name previously stored through request_credential.' },
                argv: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Command and arguments. Each element is passed through untouched; the plugin quotes them, so write ["sh","-c","…"] yourself when you need shell features.',
                },
                timeoutMs: { type: 'number', description: `Optional timeout (default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}).` },
            },
        },
        output: {
            // Two shapes, because a refusal is a normal result here: `oneOf` is in the host's supported
            // schema subset (exactly one branch must match), and the old single object shape made every
            // refusal an INVALID_TOOL_OUTPUT error — the note never reached the model.
            schema: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['exitCode', 'stdout', 'stderr', 'redacted', 'timedOut', 'aborted', 'injectedAs'],
                        properties: {
                            exitCode: { type: 'number' },
                            stdout: { type: 'string' },
                            stderr: { type: 'string' },
                            redacted: { type: 'boolean' },
                            timedOut: { type: 'boolean' },
                            aborted: { type: 'boolean' },
                            injectedAs: { type: 'string' },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['status', 'ref'],
                        properties: {
                            status: { type: 'string', const: 'refused' },
                            ref: { type: 'string' },
                            note: { type: 'string' },
                        },
                    },
                ],
            },
            render: (_args, value) => text(value),
        },
        execute: async (rawArgs, exec) => {
            const args = (rawArgs ?? {});
            const ref = initialiseName(args.ref);
            const problem = describeNameProblem(ref);
            if (problem)
                return refusal(ref, problem);
            if (!Array.isArray(args.argv) || args.argv.length === 0 || args.argv.some((item) => typeof item !== 'string')) {
                return refusal(ref, 'argv must be a non-empty array of strings');
            }
            const shell = deps.getShell();
            if (!shell?.execute)
                return refusal(ref, 'this host provides no shell surface, so the command cannot run');
            const credentials = deps.getCredentials();
            if (!credentials?.resolve)
                return refusal(ref, 'the credentials service is unavailable');
            const sessionId = exec?.agent?.id;
            const decision = authorisedFor(ref, sessionId);
            if (!decision.ok)
                return refusal(ref, `not allowed: ${decision.why}`);
            let value;
            try {
                const resolved = await credentials.resolve(ref);
                if (!resolved?.value)
                    return refusal(ref, 'the credential is not configured');
                value = resolved.value;
            }
            catch (error) {
                return refusal(ref, `could not read the credential (${failureLabel(error)})`);
            }
            const timeoutMs = clampTimeout(args.timeoutMs);
            try {
                const result = await runWithCredential(shell, { ref, argv: args.argv, value, timeoutMs, signal: exec?.signal });
                markUsed(ref);
                appendAudit({ event: 'used', ref, sessionId, exitCode: result.exitCode });
                if (result.redacted)
                    appendAudit({ event: 'redacted', ref, sessionId });
                deps.logger.info(`${USE_TOOL} ${ref}: exit ${result.exitCode}${result.redacted ? ' (redacted)' : ''}`);
                return result;
            }
            catch (error) {
                return refusal(ref, `the command could not run (${failureLabel(error)})`);
            }
        },
    };
}
/** Read the record and judge the window at the entry (design §2.3); never cached. */
function authorisedFor(ref, sessionId) {
    const verdict = authorised(ref, sessionId);
    return verdict.ok ? { ok: true } : { ok: false, why: verdict.why };
}
/** The refusal shape both tools share. */
function refusal(ref, note) {
    return { status: 'refused', ref, note };
}
function clampTimeout(requested) {
    const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS;
    return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, value));
}
/**
 * Scene component factory. It is split out so the scene can be driven without a TUI
 * (scripts/verify.mjs). React arrives through the scene props — the host React is a hard
 * contract — so nothing here imports a React of its own.
 */
function makeScene({ getCredentials, store, logger, channel = new RefusingChannel(), echo = 'dots', records = () => [], revokeGrant = () => false, revokeEveryGrant = () => [] }) {
    /**
     * The value line. `dots` is the conventional password look — one `•` per character, so the
     * length is visible by design. `none` draws nothing while typing: no characters and no length,
     * which is the stricter choice for a shared screen. `•` (not `*`) also avoids fonts that
     * ligate a run of three asterisks into a decorative glyph.
     */
    const echoLine = (value) => {
        if (echo === 'none')
            return '';
        return '\u2022'.repeat(value.length);
    };
    return function SecretsScene(props) {
        const { React, ui, close } = props;
        const h = React.createElement;
        const { Box, Text, useInput } = ui;
        const [rows, setRows] = React.useState([]);
        const [mode, setMode] = React.useState('list');
        const [cursor, setCursor] = React.useState(0);
        const [nameBuf, setNameBuf] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [scope, setScope] = React.useState('none');
        const valueRef = React.useRef(''); // the value stays out of state: state is visible to debuggers and serializers
        // True while the dialog's write is in flight: a second Enter must not start a second write.
        const busyRef = React.useRef(false);
        // A ref change does not repaint, and the echo has to follow every keystroke (with
        // `echo: none` the empty → non-empty transition is the only visible change). This counter
        // state forces the repaint; it counts repaints and never holds the value.
        const [, bumpPaint] = React.useState(0);
        const repaint = () => bumpPaint((n) => n + 1);
        // A card opened by the agent has to reach us even when the scene is already on screen:
        // the channel notifies on every appear/disappear, and the pending request decides the mode.
        React.useEffect(() => channel.subscribe(() => repaint()), []);
        const request = channel.active();
        React.useEffect(() => {
            if (!request || mode !== 'list')
                return undefined;
            // One dialog for the whole request: the value and the scope share a screen, so a request is
            // "type, pick, Enter" — not a list to navigate and not a second value step.
            setScope(offeredScopes(request.sessionId)[0]);
            setMode('request');
            return undefined;
        }, [request, mode]);
        // `grant` is what the record says; the list is where the human sees (and revokes) it.
        const grantLabel = (name) => {
            const record = records().find((entry) => entry.ref === name);
            if (!record || record.scope === 'none')
                return '';
            if (record.scope === 'until')
                return ` · agent use until ${record.expiresAt ?? 'expiry'}`;
            return ` · agent use: ${record.scope}`;
        };
        const refresh = React.useCallback(() => {
            const credentials = getCredentials();
            const names = store.loadNames();
            setRows(names.map((n) => ({ name: n, state: 'checking…', grant: grantLabel(n) })));
            let cancelled = false;
            void (async () => {
                const resolved = [];
                for (const n of names) {
                    if (!credentials) {
                        resolved.push({ name: n, state: 'service unavailable', grant: grantLabel(n) });
                        continue;
                    }
                    try {
                        const info = await credentials.describe(n);
                        const bits = [info?.configured ? 'configured' : 'not configured'];
                        if (info?.source)
                            bits.push(String(info.source));
                        if (info?.writable === false)
                            bits.push('read-only');
                        resolved.push({ name: n, state: bits.join(' · '), grant: grantLabel(n) });
                    }
                    catch (error) {
                        resolved.push({ name: n, state: `lookup failed (${failureLabel(error)})`, grant: grantLabel(n) });
                    }
                }
                if (!cancelled)
                    setRows(resolved);
            })();
            return () => { cancelled = true; };
        }, []);
        React.useEffect(() => {
            if (mode !== 'list')
                return undefined;
            return refresh();
        }, [mode]);
        React.useEffect(() => () => { valueRef.current = ''; }, []);
        // Back to the list: the value and the mode are reset here, while the notice is left to
        // the caller (setting it before calling back would be wiped by this reset).
        const back = () => { valueRef.current = ''; setMode('list'); };
        useInput((input, key) => {
            const credentials = getCredentials();
            if (mode === 'list') {
                if (key?.escape || input === 'q') {
                    close();
                    return;
                }
                if (key?.upArrow) {
                    setCursor((c) => Math.max(0, c - 1));
                    return;
                }
                if (key?.downArrow) {
                    setCursor((c) => Math.min(Math.max(0, rows.length - 1), c + 1));
                    return;
                }
                if (input === 'a') {
                    setNameBuf('');
                    setNotice('');
                    setMode('name');
                    return;
                }
                if (input === 'd' && rows[cursor]) {
                    setNotice('');
                    setMode('confirm');
                    return;
                }
                if (input === 'v' && rows[cursor]) {
                    const target = rows[cursor].name;
                    setNotice(revokeGrant(target) ? `revoked agent use for ${target}` : `no agent permission on ${target}`);
                    refresh();
                    return;
                }
                if (input === 'R') {
                    if (records().some((record) => record.scope !== 'none')) {
                        setNotice('');
                        setMode('revoke-all');
                    }
                    else
                        setNotice('no agent permission is granted');
                    return;
                }
                return;
            }
            if (mode === 'name') {
                if (key?.escape) {
                    back();
                    return;
                }
                if (key?.return) {
                    const problem = describeNameProblem(initialiseName(nameBuf));
                    if (problem) {
                        setNotice(problem);
                        return;
                    }
                    valueRef.current = '';
                    setMode('value');
                    return;
                }
                if (key?.backspace) {
                    setNameBuf((n) => n.slice(0, -1));
                    return;
                }
                if (input && !key?.ctrl && !key?.meta) {
                    setNameBuf((n) => (n + input).slice(0, 64));
                    return;
                }
                return;
            }
            if (mode === 'value') {
                if (key?.escape) {
                    back();
                    return;
                }
                if (key?.return) {
                    const secretName = initialiseName(nameBuf);
                    if (!credentials) {
                        setNotice('credentials service unavailable, nothing written');
                        back();
                        return;
                    }
                    if (valueRef.current.length === 0) {
                        setNotice('empty value, nothing written (an empty value means unconfigured)');
                        back();
                        return;
                    }
                    if (process.env[secretName]) {
                        // The process environment outranks the credential file, so the write would look like
                        // a success while every consumer keeps reading the environment value. Refuse.
                        setNotice(`${secretName} is already set in this process environment, which outranks the credential file; unset it first`);
                        back();
                        return;
                    }
                    const payload = valueRef.current;
                    valueRef.current = ''; // dropped locally before the write, so a failure leaves nothing behind
                    setMode('list');
                    void Promise.resolve()
                        .then(() => credentials.set(secretName, payload))
                        .then(() => {
                        store.addName(secretName);
                        logger.info(`set ${secretName}`);
                        setNotice(`wrote ${secretName} (the value is not kept and not shown)`);
                        refresh();
                    })
                        .catch((error) => {
                        logger.warn(`set ${secretName} failed: ${failureLabel(error)}`);
                        setNotice(`write failed (${failureLabel(error)})`);
                    });
                    return;
                }
                if (key?.backspace) {
                    valueRef.current = valueRef.current.slice(0, -1);
                    repaint();
                    return;
                }
                if (input && !key?.ctrl && !key?.meta) {
                    valueRef.current += input;
                    repaint();
                    return;
                }
                return;
            }
            if (mode === 'request') {
                if (busyRef.current)
                    return;
                const scopes = offeredScopes(request?.sessionId);
                if (key?.escape) {
                    channel.settle({ kind: 'cancelled' });
                    close(); // the dialog is done; the chat is where the agent's answer shows up
                    return;
                }
                if (key?.upArrow || key?.downArrow) {
                    // Not 1-4: in this dialog every printable key belongs to the value, digits included.
                    const index = scopes.indexOf(scope);
                    const next = key?.upArrow ? (index <= 0 ? scopes.length - 1 : index - 1) : (index + 1) % scopes.length;
                    setScope(scopes[next]);
                    return;
                }
                if (key?.return) {
                    const secretName = initialiseName(request?.ref ?? '');
                    if (!credentials) {
                        channel.settle({ kind: 'refused' });
                        setNotice('credentials service unavailable, nothing written');
                        back();
                        return;
                    }
                    if (valueRef.current.length === 0) {
                        setNotice('type the value first');
                        return;
                    }
                    if (process.env[secretName]) {
                        // Same rule as the manual path: an environment value outranks the file, so a write
                        // here would only look successful. Tell the agent "refused" and write nothing.
                        channel.settle({ kind: 'refused' });
                        setNotice(`${secretName} is already set in this process environment; unset it first`);
                        back();
                        return;
                    }
                    const payload = valueRef.current;
                    valueRef.current = '';
                    busyRef.current = true;
                    setNotice('writing…');
                    // The card is settled only after the store accepted the value: a tool that answered
                    // "stored" while the write was still failing would be lying to the model.
                    void Promise.resolve()
                        .then(() => credentials.set(secretName, payload))
                        .then(() => {
                        channel.settle({ kind: 'stored', scope });
                        close(); // one dialog, then straight back to the chat
                    })
                        .catch((error) => {
                        busyRef.current = false;
                        channel.settle({ kind: 'refused' });
                        logger.warn(`set ${secretName} failed: ${failureLabel(error)}`);
                        setNotice(`write failed (${failureLabel(error)})`);
                        back();
                    });
                    return;
                }
                if (key?.backspace) {
                    valueRef.current = valueRef.current.slice(0, -1);
                    repaint();
                    return;
                }
                if (input && !key?.ctrl && !key?.meta) {
                    valueRef.current += input;
                    repaint();
                    return;
                }
                return;
            }
            if (mode === 'revoke-all') {
                if (key?.escape || input === 'n') {
                    back();
                    return;
                }
                if (input === 'y') {
                    const revoked = revokeEveryGrant();
                    for (const entry of revoked) {
                        appendAudit({ event: 'revoked', ref: entry });
                        logger.info(`revoked the agent permission for ${entry}`);
                    }
                    setNotice(revoked.length > 0 ? `revoked ${revoked.length} agent permission(s)` : 'nothing to revoke');
                    back();
                }
                return;
            }
            if (mode === 'confirm') {
                const row = rows[cursor];
                if (key?.escape || input === 'n') {
                    back();
                    return;
                }
                if (input === 'y' && row) {
                    if (!credentials) {
                        setNotice('credentials service unavailable, nothing deleted');
                        back();
                        return;
                    }
                    const secretName = row.name;
                    setMode('list');
                    void Promise.resolve()
                        .then(() => credentials.unset(secretName))
                        .then(() => {
                        store.removeName(secretName);
                        appendAudit({ event: 'deleted', ref: secretName });
                        logger.info(`unset ${secretName}`);
                        setNotice(`deleted ${secretName}`);
                        refresh();
                    })
                        .catch((error) => {
                        logger.warn(`unset ${secretName} failed: ${failureLabel(error)}`);
                        setNotice(`delete failed (${failureLabel(error)})`);
                    });
                }
            }
        });
        const title = mode === 'list' ? 'Secrets (/secrets)'
            : mode === 'name' ? 'New reference · step 1: name'
                : mode === 'value' ? `New reference · step 2: value (${initialiseName(nameBuf)})`
                    : mode === 'request' ? `Credential requested: ${request?.ref ?? ''}`
                        : mode === 'revoke-all' ? 'Revoke every agent permission?'
                            : `Delete ${rows[cursor]?.name ?? ''}?`;
        const body = [];
        if (mode === 'list') {
            body.push(h(Text, { key: 'hint', dimColor: true }, 'a new · d delete · v revoke agent use · R revoke all · ↑/↓ select · Esc close'));
            if (rows.length === 0)
                body.push(h(Text, { key: 'empty' }, 'No references yet. Press a to start.'));
            rows.forEach((row, index) => {
                body.push(h(Text, { key: row.name, ...(index === cursor ? { inverse: true } : {}) }, `${index === cursor ? '>' : ' '} ${row.name}  ${row.state}${row.grant}`));
            });
        }
        else if (mode === 'name') {
            body.push(h(Text, { key: 'name' }, `Name: ${nameBuf || '(uppercase letters, digits, underscore)'}`));
            body.push(h(Text, { key: 'key', dimColor: true }, 'Enter next · Esc back'));
        }
        else if (mode === 'value') {
            body.push(h(Text, { key: 'value' }, `Value: ${valueRef.current.length > 0 ? echoLine(valueRef.current) : '(waiting for input)'}`));
            body.push(h(Text, { key: 'key', dimColor: true }, 'Enter saves · Esc cancels'));
        }
        else if (mode === 'request') {
            // One screen: the value and the scope together. No list, no separate value step — type,
            // pick with ↑/↓, Enter, and the dialog closes back to the chat.
            const scopes = offeredScopes(request?.sessionId);
            body.push(h(Text, { key: 'purpose', dimColor: true }, `Purpose: ${request?.purpose ?? ''}`));
            body.push(h(Text, { key: 'value' }, `Value: ${valueRef.current.length > 0 ? echoLine(valueRef.current) : '(type it)'}`));
            scopes.forEach((option) => {
                body.push(h(Text, { key: option, ...(option === scope ? { inverse: true } : {}) }, `${option === scope ? '>' : ' '} ${SCOPE_LABEL[option]}`));
            });
            body.push(h(Text, { key: 'key', dimColor: true }, 'Enter saves · ↑/↓ scope · Esc cancels'));
        }
        else if (mode === 'revoke-all') {
            body.push(h(Text, { key: 'warn' }, 'Every agent permission is revoked; stored values stay. y confirms · n/Esc cancels'));
        }
        else {
            body.push(h(Text, { key: 'warn' }, 'This deletes the reference and its stored value. y confirms · n/Esc cancels'));
        }
        if (notice)
            body.push(h(Text, { key: 'notice', color: 'yellow' }, notice));
        // Centered like a dialog: the outer box fills the screen and the inner one is the card. The
        // list stays top-aligned (a long reference list must not clip its own header); every dialog
        // mode centers both ways. Width is responsive with a cap, so a wide terminal does not stretch
        // the card and a narrow one still fits.
        return h(Box, {
            flexDirection: 'column',
            flexGrow: 1,
            width: '100%',
            alignItems: 'center',
            justifyContent: mode === 'list' ? 'flex-start' : 'center',
        }, h(Box, { flexDirection: 'column', paddingX: 1, borderStyle: 'round', width: '80%', maxWidth: 76 }, h(Text, { key: 'title', bold: true }, title), ...body));
    };
}
/**
 * For tests: the same construction as apply, without Cordis.
 * @internal
 */
export const __internals = { makeScene, SCENE_ID, DEFAULTS, REQUEST_TOOL, USE_TOOL };
