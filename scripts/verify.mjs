// Acceptance script: two layers of evidence.
//   1. Scene-side sentinel checks: a value reaches ctx.credentials and nothing else — no
//      rendered frame, no log line, no outbound call and no model-facing surface ever holds it.
//   2. CLI-side write checks: the command shares the provider's lock, performs a row-level
//      upsert only, and is fail-closed wherever a premise is missing.
//   3. A declaration gate: dsh-plugin.json is run through the host's own @dsh-std/manifest
//      parser and the TUI profile validator, so a drifted manifest fails here, not at
//      admission.
//
// How the scene half works: a minimal React hook runtime and a ui kit stand-in drive the real
// scene in real key order (`a` → name → Enter → value → Enter), recording every rendered frame,
// every log line and every outbound call, then grepping for a sentinel value. Step ⑫ swaps in
// the host's own React 19 and ink, rendering into a non-TTY stream frame by frame — element
// symbols, hook dispatcher and render path are all real.
//
// What it does NOT prove (do not treat this script as the whole case):
//   - a real terminal's scrollback or session recording; that needs a real TTY.
//   - writers outside the terminal (the web card, or `dsh` writing the same credential file).
//
// Usage: node scripts/verify.mjs   (npm test / npm run verify share this entry point)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// The name index goes to an isolated directory; a real ~/.dsh-tui is never touched.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-secret-verify-'))
process.env.DSH_TUI_HOME = SCRATCH

const SENTINEL = 'SENTINEL_p4ssw0rd_DO_NOT_LEAK_7f3a'
const SENTINEL2 = 'x9'

// The tests exercise the compiled package: `src/` is the source, `lib/types/` is tsc output
// and is not in git (package.json's `pretest` compiles it). A missing build is reported as a
// missing build, not as a module-resolution stack.
if (!fs.existsSync(new URL('../lib/types/index.js', import.meta.url))) {
  console.error('lib/types/index.js is missing — run `pnpm install` once, then `npm run compile` (or just `npm test`, which compiles first)')
  process.exit(1)
}

const plugin = await import('../lib/types/index.js')
const store = await import('../lib/types/store.js')
const { makeScene } = plugin.__internals

const results = []
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
class Skip extends Error {}
async function check(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    if (error instanceof Skip) {
      results.push({ label, ok: true, skip: true, detail: error.message })
      return
    }
    results.push({ label, ok: false, detail: error?.message ?? String(error) })
  }
}

// ---------------------------------------------------------------- minimal hook runtime
function sameDeps(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectStrings(child, out); return out }
  if (typeof node === 'object' && node.props) collectStrings(node.props.children, out)
  return out
}

/**
 * Mount the scene component on a persistent hook table: render() calls the component again and
 * press() invokes the handler captured by useInput, then repaints — the smallest useful ink
 * skeleton.
 */
function mount(component, props) {
  const hooks = []
  let handler
  let dirty = true
  const frames = []

  const React = {
    createElement(type, config, ...children) {
      const child = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(config ?? {}), children: child } }
    },
    useState(initial) {
      const index = hooks.index++
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = hooks[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; dirty = true }]
    },
    useRef(initial) {
      const index = hooks.index++
      if (!(index in hooks)) hooks[index] = { value: { current: initial } }
      return hooks[index].value
    },
    useCallback(fn, deps) {
      const index = hooks.index++
      const slot = hooks[index]
      if (!slot || !sameDeps(slot.deps, deps)) hooks[index] = { value: fn, deps }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = hooks.index++
      const slot = hooks[index]
      if (slot && sameDeps(slot.deps, deps)) return
      if (slot?.cleanup) slot.cleanup()
      const cleanup = fn()
      hooks[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    },
  }

  const ui = { Box: 'Box', Text: 'Text', useInput: (fn) => { handler = fn } }

  const render = () => {
    // Like React, run "render → synchronous setState in an effect → render" to convergence.
    let guard = 0
    do {
      dirty = false
      hooks.index = 0
      frames.push(collectStrings(component({ ...props, React, ui })).join('\n'))
    } while (dirty && (guard += 1) < 10)
  }
  // As in React, only a state change repaints; a ref change alone does not update the screen
  // (deliberate: a mask driven by a ref alone would freeze on the previous frame — the real
  // host render, step ⑫, is what caught exactly that).
  const press = (input, key = {}) => { handler(input, key); if (dirty) render() }

  render()
  return {
    frames,
    press,
    render,
    maskOf() { return this.text.match(/Value: (\S*)/)?.[1] ?? '' },
    get text() { return frames[frames.length - 1] ?? '' },
  }
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------- the scene writes to one place only
const setCalls = []
const unsetCalls = []
const pluginLog = []
const credentials = {
  async describe() { return { configured: false, source: 'file', writable: true } },
  async set(ref, value) { setCalls.push({ ref, value }) },
  async unset(ref) { unsetCalls.push({ ref }) },
}
const scene = makeScene({
  getCredentials: () => credentials,
  store: { loadNames: () => ['ALREADY_THERE'], addName: () => {}, removeName: () => {} },
  logger: { info: (m) => pluginLog.push(m), warn: (m) => pluginLog.push(m) },
})

let closed = 0
const view = mount(scene, { channel: {}, close: () => { closed += 1 } })

await check('① an empty value is refused: Enter writes nothing', async () => {
  view.press('a')
  for (const ch of 'MY_TOKEN') view.press(ch)
  view.press('\r', { return: true })
  assert(view.text.includes('step 2'), `did not reach the value step: ${view.text}`)
  view.press('\r', { return: true })
  await flush()
  assert(setCalls.length === 0, `an empty value called set (${setCalls.length} times)`)
  assert(view.text.includes('empty value'), `no empty-value notice: ${view.text}`)
})

await check('② a reserved prefix is refused: DSH_ names are not accepted', async () => {
  view.press('a')
  for (const ch of 'DSH_FOO') view.press(ch)
  view.press('\r', { return: true })
  assert(!view.text.includes('step 2'), 'a DSH_ prefix reached the value step')
  assert(view.text.includes('belong to the host'), `no reason given for the reserved prefix: ${view.text}`)
  view.press('\u001b', { escape: true }) // back to the list
})

const maskFrames = []
await check('③ per-keystroke masking: only a fixed mask on screen, no value and no length', async () => {
  view.press('a')
  for (const ch of 'MY_TOKEN') view.press(ch)
  view.press('\r', { return: true })
  assert(view.text.includes('step 2'), `did not reach the value step: ${view.text}`)
  for (const ch of SENTINEL) {
    view.press(ch)
    const frame = view.text
    maskFrames.push(frame)
    assert(!frame.includes(SENTINEL), 'the full sentinel value reached the screen')
    // Only the value line is checked for echoed characters: short prefixes of the sentinel
    // also occur in ordinary prose on the same frame, so scanning the whole frame for a
    // single letter would be a false positive. A value line that is nothing but mask
    // characters is a strictly stronger statement anyway.
    const segment = frame.match(/Value: (\S*)/)?.[1] ?? ''
    assert(/^\u2022+$/.test(segment), `the value line shows something other than the mask: "${segment}"`)
  }
  const masks = maskFrames.map((frame) => frame.match(/Value: (\S*)/)?.[1] ?? '')
  assert(masks.every((mask) => mask === masks[0]), `the mask changed with length: ${JSON.stringify(masks)}`)
  assert(masks[0].includes('\u2022'), `no mask was drawn (a ref change alone does not repaint?): "${masks[0]}"`)
  assert(!/\d/.test(masks[0]), `the mask contains digits (a length hint): ${masks[0]}`)
})

await check('④ the value reaches credentials.set only: zero hits in frames and logs', async () => {
  view.press('\r', { return: true })
  await flush()
  view.render()
  assert(setCalls.length === 1, `set should have been called once, was ${setCalls.length}`)
  assert(setCalls[0].ref === 'MY_TOKEN', `wrong reference name: ${setCalls[0].ref}`)
  assert(setCalls[0].value === SENTINEL, 'set did not receive the typed value')
  const frameHits = view.frames.filter((frame) => frame.includes(SENTINEL))
  assert(frameHits.length === 0, `${frameHits.length} rendered frames contain the sentinel`)
  const logHits = pluginLog.filter((line) => line.includes(SENTINEL))
  assert(logHits.length === 0, `the log contains the sentinel: ${logHits.join(' | ')}`)
  assert(pluginLog.some((line) => line.includes('MY_TOKEN')), `the name was not logged: ${pluginLog.join(' | ')}`)
  assert(view.text.includes('wrote MY_TOKEN'), `wrong confirmation after the write: ${view.text}`)
})

await check('⑤ a short value (2 characters) also stays off screen', async () => {
  view.press('a')
  for (const ch of 'OTHER') view.press(ch)
  view.press('\r', { return: true })
  for (const ch of SENTINEL2) {
    view.press(ch)
    assert(!view.text.includes(SENTINEL2), 'the short value was echoed')
  }
  view.press('\r', { return: true })
  await flush()
  view.render()
  assert(setCalls.length === 2, `the second set never happened (${setCalls.length})`)
  assert(view.frames.every((frame) => !frame.includes(SENTINEL2)), 'a frame holds the short sentinel')
})

await check('⑥ deletion needs an explicit y; any other key deletes nothing', async () => {
  view.press('d')
  assert(view.text.includes('Delete '), `did not enter the confirm step: ${view.text}`)
  view.press('x')
  await flush()
  assert(unsetCalls.length === 0, 'pressing x deleted something')
  assert(view.text.includes('Delete '), 'pressing x left the confirm step')
  view.press('y')
  await flush()
  view.render()
  assert(unsetCalls.length === 1, `unset should have been called once, was ${unsetCalls.length}`)
})

await check('⑥b with credentials missing, deletion is not reported as done', async () => {
  const noService = makeScene({
    getCredentials: () => undefined,
    store: { loadNames: () => ['GONE'], addName: () => {}, removeName: () => {} },
    logger: { info: () => {}, warn: () => {} },
  })
  const v = mount(noService, { channel: {}, close: () => {} })
  v.press('d')
  assert(v.text.includes('Delete '), `did not enter the confirm step: ${v.text}`)
  v.press('y')
  await flush()
  v.render()
  assert(!v.text.includes('deleted GONE'), `reported a deletion without the service: ${v.text}`)
  assert(v.text.includes('nothing deleted') || v.text.includes('unavailable'), `no reason given: ${v.text}`)
})

await check('⑦ Esc closes the scene', async () => {
  view.press('\u001b', { escape: true })
  assert(closed === 1, `close() was called ${closed} times`)
})

await check('⑧ a failed write reports the error code only, never the value or raw error text', async () => {
  const logs = []
  const sceneWithLog = makeScene({
    getCredentials: () => ({
      async describe() { return { configured: false, writable: true } },
      async set() { const error = new Error(`rejected because value ${SENTINEL} is bad`); error.code = 'EACCES'; throw error },
      async unset() {},
    }),
    store: { loadNames: () => [], addName: () => {}, removeName: () => {} },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  })
  const v = mount(sceneWithLog, { channel: {}, close: () => {} })
  v.press('a')
  for (const ch of 'NOPE') v.press(ch)
  v.press('\r', { return: true })
  for (const ch of SENTINEL) v.press(ch)
  v.press('\r', { return: true })
  await flush()
  v.render()
  assert(v.text.includes('EACCES'), `the error code was not reported: ${v.text}`)
  assert(!v.text.includes(SENTINEL), 'the value leaked into the error notice')
  assert(!v.frames.some((frame) => frame.includes(SENTINEL)), 'a frame holds the sentinel')
  assert(!logs.some((line) => line.includes(SENTINEL)), `the raw error text reached the log: ${logs.join(' | ')}`)
})

// ---------------------------------------------------------------- mounting surface: no model-facing exit
await check('⑨ apply touches two seams only and mounts no model-facing hook', async () => {
  const calls = { inject: [], on: [], once: [], effect: 0 }
  const fakeCtx = {
    logger: { info: () => {}, warn: () => {} },
    inject: (services, cb) => { calls.inject.push({ services, cb }) },
    on: (event, cb) => { calls.on.push({ event, cb }) },
    once: (event, cb) => { calls.once.push({ event, cb }) },
    effect: () => { calls.effect += 1 },
    get: () => undefined,
  }
  plugin.apply(fakeCtx)

  const services = calls.inject.map((entry) => entry.services.join(','))
  assert(services.includes('tuiScenes'), `tuiScenes was not mounted: ${services.join('|')}`)
  assert(services.includes('commands'), `commands was not mounted: ${services.join('|')}`)
  assert(calls.on.length === 0, `${calls.on.length} cordis events were mounted (a model-facing exit): ${calls.on.map((e) => e.event).join(',')}`)
  assert(calls.once.length === 0, `${calls.once.length} once-listeners were mounted`)

  const registered = []
  calls.inject.find((entry) => entry.services.includes('tuiScenes')).cb({
    tuiScenes: { register: (descriptor, identity) => { registered.push({ descriptor, identity }); return () => {} } },
  })
  assert(calls.effect >= 1, `no cleanup was mounted after the scene registration (ctx.effect ${calls.effect})`)
  assert(registered.length === 1, 'the scene was not registered')
  assert(registered[0].descriptor.id === 'secrets', `the scene id is not secrets: ${registered[0].descriptor.id}`)
  assert(typeof registered[0].descriptor.component === 'function', 'the scene has no component')
  assert(registered[0].identity === fakeCtx, 'register was not given the identity (the effect ledger would record undeclared)')

  // Command surface: the mediated surface comes first (with attribution); absent or refusing
  // surfaces fall back to a direct registration.
  const commandCb = calls.inject.find((entry) => entry.services.includes('commands')).cb
  const attributed = []
  fakeCtx.get = (service) => (service === 'tuiPluginHost'
    ? { registerCommand: (pluginCtx, def) => { attributed.push({ pluginCtx, def }); return () => {} } }
    : undefined)
  let direct = 0
  const commandServices = { commands: { register: () => { direct += 1; return () => {} } } }
  commandCb(commandServices)
  assert(calls.effect >= 2, `no cleanup was mounted after the command registration (ctx.effect ${calls.effect})`)
  assert(attributed.length === 1, `the mediated surface was not used (attributed ${attributed.length})`)
  assert(attributed[0].pluginCtx === fakeCtx, 'the mediated surface did not receive this plugin ctx')
  assert(direct === 0, 'the command was registered twice when the mediated surface worked')

  // A refusing mediated surface must fall back, never lose the command.
  fakeCtx.get = (service) => (service === 'tuiPluginHost'
    ? { registerCommand: () => { const error = new Error('denied'); error.code = 'PERMISSION_NOT_GRANTED'; throw error } }
    : undefined)
  commandCb(commandServices)
  assert(direct === 1, `no fallback after the mediated refusal (direct ${direct})`)

  let definition = attributed[0].def
  assert(definition?.name === 'secrets', `the command name is not secrets: ${definition?.name}`)
  assert(!JSON.stringify(definition.description).includes(SENTINEL), 'the command description holds the sentinel')

  // With no scene surface: fail loudly rather than silently.
  fakeCtx.get = () => undefined
  const noScene = definition.handler()
  assert(noScene.kind === 'error', `no error when the scene surface is missing: ${JSON.stringify(noScene)}`)
  assert(noScene.text.includes('tuiScenes'), `the error does not say what is missing: ${noScene.text}`)

  // Scene surface present: silent success; an unregistered id is an error.
  const opened = []
  fakeCtx.get = () => ({ open: (id) => { opened.push(id); return true } })
  const ok = definition.handler()
  assert(ok.kind === 'success', `the happy path did not return a silent success: ${JSON.stringify(ok)}`)
  assert(Object.keys(ok).length === 1, `the success result carries content: ${JSON.stringify(ok)}`)
  assert(opened[0] === 'secrets', `open was given the wrong id: ${opened[0]}`)
  fakeCtx.get = () => ({ open: () => false })
  assert(definition.handler().kind === 'error', 'an open() returning false produced no error')
})

// ---------------------------------------------------------------- the name index
await check('⑩ the name index holds names only; file 0600, directory 0700', async () => {
  store.addName('MY_TOKEN')
  store.addName('OTHER')
  const file = path.join(SCRATCH, 'dsh-tui-secret', 'refs.json')
  const raw = fs.readFileSync(file, 'utf8')
  assert(!raw.includes(SENTINEL) && !raw.includes(SENTINEL2), 'a value reached the name index')
  const names = store.loadNames()
  assert(names.includes('MY_TOKEN') && names.includes('OTHER'), `names were not persisted: ${names.join(',')}`)
  assert((fs.statSync(file).mode & 0o777) === 0o600, `refs.json mode is ${(fs.statSync(file).mode & 0o777).toString(8)}, expected 600`)
  assert((fs.statSync(path.dirname(file)).mode & 0o777) === 0o700, `directory mode is ${(fs.statSync(path.dirname(file)).mode & 0o777).toString(8)}, expected 700`)
})

await check('⑪ a damaged name index is neither overwritten nor fatal', async () => {
  const file = path.join(SCRATCH, 'dsh-tui-secret', 'refs.json')
  fs.writeFileSync(file, '{ this is not json')
  assert(store.loadNames().length === 0, 'a damaged file should read as empty')
  assert(fs.readFileSync(file, 'utf8') === '{ this is not json', 'the damaged file was overwritten')
})

// ---------------------------------------------------------------- real host render
// The previous group used the hand-written runtime; this one uses the host's own React and ink,
// so element symbols, the hook dispatcher and the render path are the real ones. It catches
// what a stand-in cannot — this is the group that caught "the mask is driven by a ref alone,
// so the screen never repaints".
// It needs a dsh-TUI profile on this machine; without one it SKIPs rather than failing.
await check('⑫ real host render (real React + real ink): the mask repaints and no value lands on screen', async () => {
  const profile = process.env.DSH_TUI_PROFILE ?? path.join(os.homedir(), '.dsh/profiles/dsh-tui')
  const pkg = path.join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js')
  const reactEntry = path.join(profile, 'node_modules/react/index.js')
  if (!fs.existsSync(pkg) || !fs.existsSync(reactEntry)) {
    throw new Skip(`no dsh-TUI profile at ${profile}, skipping the real host render`)
  }
  const { PassThrough } = await import('node:stream')
  const { pathToFileURL } = await import('node:url')
  const HostReact = await import(pathToFileURL(reactEntry).href)
  const hostUi = await import(pathToFileURL(pkg).href)

  const calls = []
  const hostScene = makeScene({
    getCredentials: () => ({
      async describe() { return { configured: true, source: 'file', writable: true } },
      async set(ref, value) { calls.push({ ref, value }) },
      async unset() {},
    }),
    store: { loadNames: () => ['ALPHA'], addName: () => {}, removeName: () => {} },
    logger: { info: () => {}, warn: () => {} },
  })

  const stdout = new PassThrough()
  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = false // non-TTY: ink writes whole frames instead of diffs, so frames can be grepped
  let out = ''
  stdout.on('data', (chunk) => { out += chunk.toString() })

  let handler
  const element = HostReact.createElement(hostScene, {
    React: HostReact,
    ui: { ...hostUi, useInput: (fn) => { handler = fn } },
    channel: {},
    close: () => {},
  })
  const instance = hostUi.renderSync(element, { stdout, stdin: process.stdin, patchConsole: false })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 40))
  const frame = () => out.slice(Math.max(0, out.lastIndexOf('\u001b[?2026h')))
  const tap = async (input, key = {}) => { handler(input, key); await tick() }

  try {
    await tick()
    assert(out.includes('ALPHA'), 'the first frame did not render the list')
    await tap('a')
    assert(out.includes('step 1'), 'did not reach the name step')
    for (const ch of 'MY_TOKEN') await tap(ch)
    await tap('\r', { return: true })
    assert(out.includes('step 2'), 'did not reach the value step')

    const masks = []
    for (const ch of SENTINEL) {
      await tap(ch)
      assert(!out.includes(SENTINEL), 'the sentinel value appeared in the real host render')
      const segment = frame().match(/Value: (\S*)/)?.[1] ?? ''
      masks.push(segment)
      assert(/^\u2022+$/.test(segment), `the value line shows something other than the mask: "${segment}"`)
    }
    assert(masks.every((mask) => mask === masks[0]), `the mask changed with length: ${JSON.stringify(masks)}`)
    assert(masks[0].includes('\u2022'), `no mask was drawn (a ref change alone does not repaint?): "${masks[0]}"`)
    assert(!/\d/.test(masks[0]), `the mask contains digits: ${masks[0]}`)

    await tap('\r', { return: true })
    await tick()
    assert(calls.length === 1 && calls[0].value === SENTINEL, 'the value did not reach credentials.set')
    assert(!out.includes(SENTINEL), 'the sentinel appeared in a frame after the write')
  } finally {
    instance.unmount()
  }
})

// ---------------------------------------------------------------- quoting: the model's argv is data, not shell text
// `use_credential` takes an argv array and builds the command string itself (the shell seam
// wants a string), so the quoting is our attack surface. It is proved against a real /bin/sh
// rather than by reading the code: whatever the model sends stays data, and only a script the
// model writes itself — `['sh','-c','…']` — is expanded, by that inner shell.
const { quoteArg, toCommand, runWithCredential, injectedName } = await import('../lib/types/use.js')

/** A stand-in for ctx.shell that really runs the command string through /bin/sh. */
function shellStub() {
  const seen = []
  return {
    seen,
    resolve(request) { seen.push(request); return request },
    async execute(spec) {
      const run = spawnSync('/bin/sh', ['-c', spec.command], {
        env: { ...process.env, ...(spec.env ?? {}) },
        encoding: 'utf8',
      })
      return { result: async () => ({ exitCode: run.status ?? -1, stdout: run.stdout, stderr: run.stderr, timedOut: false, aborted: false }) }
    },
  }
}

await check('⑬ hostile argv stays data: metacharacters, quotes, backticks, newline and an empty argument', async () => {
  const hostile = ['printf', '%s\\n', 'a; rm -rf /', '$(id)', '`id`', '"double"', "it's", 'line\nbreak', '']
  assert(quoteArg("it's") === "'it'\\''s'", `a single quote is not escaped: ${quoteArg("it's")}`)
  let threw = false
  try { toCommand([]) } catch { threw = true }
  assert(threw, 'an empty argv must be refused, not turned into an empty command')

  const shell = shellStub()
  const result = await runWithCredential(shell, { ref: 'ALPHA', argv: hostile, value: 'NOT_IN_OUTPUT', timeoutMs: 5_000 })
  // `printf '%s\n' a b c` prints one argument per line, so exact equality proves every argument
  // arrived whole — including the one holding a real newline (it must not split the command).
  const expected = hostile.slice(2).join('\n') + '\n'
  assert(result.exitCode === 0, `the hostile command failed: exit ${result.exitCode} ${result.stderr}`)
  assert(result.stdout === expected, `an argument did not arrive as data:\n${JSON.stringify(result.stdout)}\n!==\n${JSON.stringify(expected)}`)
  assert(result.stdout.split('\n')[0] === 'a; rm -rf /', `metacharacters were interpreted: ${JSON.stringify(result.stdout.split('\n')[0])}`)
  assert(result.stdout.includes('$(id)') && result.stdout.includes('`id`'), 'command substitution ran')
  assert(shell.seen[0].env[injectedName('ALPHA')] === 'NOT_IN_OUTPUT', 'the value was not put in the child env')
})

await check('⑭ the value does not expand outside a shell the model writes itself', async () => {
  const shell = shellStub()
  const result = await runWithCredential(shell, {
    ref: 'ALPHA',
    argv: ['echo', `$${injectedName('ALPHA')}`],
    value: 'CLI_SENTINEL_QUOTING_4f21',
    timeoutMs: 5_000,
  })
  assert(result.exitCode === 0, `echo failed: ${result.stderr}`)
  assert(result.stdout === '$DSH_SECRET_ALPHA\n', `the value expanded where it must not: ${JSON.stringify(result.stdout)}`)
  assert(!result.stdout.includes('CLI_SENTINEL_QUOTING_4f21'), 'the value reached the output untouched')
  assert(result.redacted === false, 'nothing needed redaction here')
})

await check('⑮ a script the model writes itself is expanded — and its output is still redacted', async () => {
  const shell = shellStub()
  const value = 'CLI_SENTINEL_QUOTING_4f21'
  const result = await runWithCredential(shell, {
    ref: 'ALPHA',
    argv: ['sh', '-c', `printf 'token=%s\\n' "$${injectedName('ALPHA')}"`],
    value,
    timeoutMs: 5_000,
  })
  assert(result.exitCode === 0, `sh -c failed: ${result.stderr}`)
  assert(result.stdout === 'token=[credential]\n', `the inner script's output was not redacted: ${JSON.stringify(result.stdout)}`)
  assert(result.redacted === true, 'the redaction flag was not set')
  assert(result.injectedAs === injectedName('ALPHA'), `wrong env name reported: ${result.injectedAs}`)
  assert(!result.stdout.includes(value) && !result.stderr.includes(value), 'the value survived in the returned output')
})

// ---------------------------------------------------------------- the declaration gate
// The plugin declaration is consumed twice: the community parser validates its structure
// (and the host derives the plugin identity from projection.metadata.name), while the TUI
// profile adds semantic rules on top of it. Both are checked here against the host install,
// offline, so a drifted manifest fails locally instead of at admission.
await check('⑳ the declaration passes the upstream parser and the TUI profile gate', async () => {
  const hostDir = path.join(os.homedir(), '.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui')
  const parserEntry = path.join(hostDir, 'node_modules/@dsh-std/manifest/lib/index.js')
  if (!fs.existsSync(parserEntry)) {
    throw new Skip(`no dsh-TUI host install at ${hostDir}, skipping the declaration gate`)
  }
  const { pathToFileURL } = await import('node:url')
  const parser = await import(pathToFileURL(parserEntry).href)
  const source = fs.readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8')

  let manifest
  try {
    const parsed = parser.parseManifest(source)
    manifest = parsed.manifest ?? parsed
  } catch (error) {
    throw new Error(`parseManifest rejected dsh-plugin.json: ${error?.message ?? error}`)
  }
  const projection = parser.projectManifest(manifest)
  // The host keys the plugin identity on this value (componentId), so it has to be the id.
  assert(projection.metadata.name === manifest.id, `projection.metadata.name ${projection.metadata.name} is not the manifest id ${manifest.id}`)
  assert(typeof manifest.description === 'undefined', 'description is not a community v0.15 field; use x-description')
  assert(Array.isArray(manifest.subscriptions), 'subscriptions is required by the schema')

  const data = (await import(pathToFileURL(path.join(hostDir, 'lib/types/adapter/standard/registry.js')).href)).loadSpecData()
  if (data === undefined) throw new Skip('the host ships no TUI profile spec data, skipping the profile gate')
  const { createContractIndex, validatePlugin } = await import(pathToFileURL(path.join(hostDir, 'lib/types/adapter/standard/validate.js')).href)
  const index = createContractIndex(data.registry, data.permissions)
  assert(index.facetApiVersions.includes(manifest.facets.host.apiVersion), `facet apiVersion is not admitted: ${manifest.facets.host.apiVersion}`)
  validatePlugin(index, manifest)
})

// ---------------------------------------------------------------- summary
const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  const tag = entry.skip ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${entry.label}${entry.ok && !entry.skip ? '' : `\n      ${entry.detail ?? ''}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} PASS · sentinel ${SENTINEL.length} chars · scratch ${SCRATCH}`)
if (failed.length > 0) process.exitCode = 1
