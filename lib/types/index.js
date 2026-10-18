// dsh-tui-secret — secure secret entry inside dsh-TUI (a value only ever reaches
// ctx.credentials).
//
// Plugin contract (tui-profile plugin guide, "plugin contract"):
//   - the package root exports `name` / `apply`, with no default export;
//   - every configuration key has a default, and a missing service degrades silently —
//     the TUI must always start;
//   - resources are released through ctx.effect(() => () => dispose()).
//
// The three seams this plugin uses, and why:
//   - tuiScenes registers the `/secrets` full-screen scene. Masked input has to happen on
//     a screen we render ourselves: dsh-TUI 0.16.0 already declares a `secret` field for
//     settings sections, but its settings screen does not render a mask yet.
//   - the scene is opened by our own slash command, whose name comes from
//     `config.entryCommand`.
//   - credentials (a DSH core service) is the only write surface:
//     resolve / describe / set / unset. It has no list(), so "which names were recorded"
//     has to be stored here (store.ts, names only).
//
// The host seams below are typed structurally on purpose: this package declares only the
// little it consumes, so a host release that changes an unrelated part of `Context` does
// not break the build here (and no host type package is needed to compile).
import { describeNameProblem, initialiseName, loadNames, addName, removeName } from './store.js';
export const name = 'dsh-tui-secret';
/** Scene id: kebab-case, globally unique. */
const SCENE_ID = 'secrets';
/** Exported for tests and documentation: the defaults this plugin declares. */
export const DEFAULTS = {
    /** Slash-command name that opens the scene, without the slash. */
    entryCommand: 'secrets',
    /** Scene title, for logs and debugging; the scene draws its own header. */
    title: 'Secrets',
};
/** The error label used in notices and logs: code/name only, because raw text may embed a value. */
function failureLabel(error) {
    const failure = error;
    return String(failure?.code || failure?.name || 'unknown');
}
/**
 * Plugin entry. Registers two seams declaratively through ctx.inject; every resource is
 * disposed on the fibre that called apply.
 *
 * @param ctx - the Cordis context.
 * @param config - from cordis.patch.yml.
 */
export function apply(ctx, config) {
    const options = { ...DEFAULTS, ...(config ?? {}) };
    const seams = ctx;
    // The index of recorded reference names (names only; values belong to dsh-credentials
    // and are never read here).
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
    const scene = makeScene({ getCredentials, store, logger });
    seams.inject(['tuiScenes'], (sceneCtx) => {
        const dispose = sceneCtx.tuiScenes.register({ id: SCENE_ID, title: options.title, component: scene }, ctx);
        seams.effect(() => () => dispose());
        logger.info(`scene ${SCENE_ID} registered`);
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
                const opened = scenes.open(SCENE_ID);
                return opened
                    ? { kind: 'success' }
                    : { kind: 'error', text: 'the secrets scene is not registered (the plugin may be disabled)' };
            },
        };
        // The mediated surface comes first (C-041): a command registered through it carries
        // this plugin's verified identity, which is what lets the host's invoke checkpoint
        // honour per-owner denies (revoking `commands.invoke` then closes this entry point).
        // When the mediated surface is absent (older patch, or admission refused) we fall
        // back to a direct registration, which the same-process trust boundary (C-070)
        // explicitly allows — it simply carries no attribution. Both paths return the same
        // disposer shape.
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
}
/**
 * Scene component factory. It is split out so the scene can be driven without a TUI
 * (scripts/verify.mjs). React arrives through the scene props — the host React is a hard
 * contract — so nothing here imports a React of its own.
 */
function makeScene({ getCredentials, store, logger }) {
    const MASK = '\u2022\u2022\u2022\u2022'; // fixed-length placeholder: neither the value nor its length
    return function SecretsScene(props) {
        const { React, ui, close } = props;
        const h = React.createElement;
        const { Box, Text, useInput } = ui;
        const [rows, setRows] = React.useState([]);
        const [mode, setMode] = React.useState('list');
        const [cursor, setCursor] = React.useState(0);
        const [nameBuf, setNameBuf] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const valueRef = React.useRef(''); // the value stays out of state: state is visible to debuggers and serializers
        // A ref change does not repaint, and the mask has to follow every keystroke. This
        // counter state forces the repaint; it counts repaints and never holds the value.
        const [, bumpPaint] = React.useState(0);
        const repaint = () => bumpPaint((n) => n + 1);
        const refresh = React.useCallback(() => {
            const credentials = getCredentials();
            const names = store.loadNames();
            setRows(names.map((n) => ({ name: n, state: 'checking…' })));
            let cancelled = false;
            void (async () => {
                const resolved = [];
                for (const n of names) {
                    if (!credentials) {
                        resolved.push({ name: n, state: 'service unavailable' });
                        continue;
                    }
                    try {
                        const info = await credentials.describe(n);
                        const bits = [info?.configured ? 'configured' : 'not configured'];
                        if (info?.source)
                            bits.push(String(info.source));
                        if (info?.writable === false)
                            bits.push('read-only');
                        resolved.push({ name: n, state: bits.join(' · ') });
                    }
                    catch (error) {
                        resolved.push({ name: n, state: `lookup failed (${failureLabel(error)})` });
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
                    const payload = valueRef.current;
                    valueRef.current = ''; // dropped locally before the write, so a failure leaves nothing behind
                    setMode('list');
                    void Promise.resolve()
                        .then(() => credentials.set(secretName, payload))
                        .then(() => {
                        store.addName(secretName);
                        logger.info?.(`set ${secretName}`);
                        setNotice(`wrote ${secretName} (the value is not kept and not shown)`);
                        refresh();
                    })
                        .catch((error) => {
                        logger.warn?.(`set ${secretName} failed: ${failureLabel(error)}`);
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
                        logger.info?.(`unset ${secretName}`);
                        setNotice(`deleted ${secretName}`);
                        refresh();
                    })
                        .catch((error) => {
                        logger.warn?.(`unset ${secretName} failed: ${failureLabel(error)}`);
                        setNotice(`delete failed (${failureLabel(error)})`);
                    });
                }
            }
        });
        const title = mode === 'list' ? 'Secrets (/secrets)'
            : mode === 'name' ? 'New reference · step 1: name'
                : mode === 'value' ? `New reference · step 2: value (${initialiseName(nameBuf)})`
                    : `Delete ${rows[cursor]?.name ?? ''}?`;
        const body = [];
        if (mode === 'list') {
            body.push(h(Text, { key: 'hint', dimColor: true }, 'a new · d delete · ↑/↓ select · Esc close'));
            if (rows.length === 0)
                body.push(h(Text, { key: 'empty' }, 'No references yet. Press a to start.'));
            rows.forEach((row, index) => {
                body.push(h(Text, { key: row.name, ...(index === cursor ? { inverse: true } : {}) }, `${index === cursor ? '>' : ' '} ${row.name}  ${row.state}`));
            });
        }
        else if (mode === 'name') {
            body.push(h(Text, { key: 'name' }, `Name: ${nameBuf || '(uppercase letters, digits, underscore)'}`));
            body.push(h(Text, { key: 'key', dimColor: true }, 'Enter next · Esc back'));
        }
        else if (mode === 'value') {
            body.push(h(Text, { key: 'value' }, `Value: ${valueRef.current.length > 0 ? MASK : '(waiting for input)'}`));
            body.push(h(Text, { key: 'key', dimColor: true }, 'masked · Enter writes · Esc discards'));
        }
        else {
            body.push(h(Text, { key: 'warn' }, 'This removes the name from the DSH credential store. y confirms · n/Esc cancels'));
        }
        if (notice)
            body.push(h(Text, { key: 'notice', color: 'yellow' }, notice));
        return h(Box, { flexDirection: 'column', paddingX: 1, borderStyle: 'round' }, h(Text, { key: 'title', bold: true }, title), h(Text, { key: 'disc', dimColor: true }, 'Values reach ctx.credentials only: never echoed, never logged, never in the conversation.'), ...body);
    };
}
/**
 * For tests: the same construction as apply, without Cordis.
 * @internal
 */
export const __internals = { makeScene, SCENE_ID, DEFAULTS };
