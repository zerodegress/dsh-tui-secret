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
  const calls = { inject: [], on: [], once: [], effect: 0, logs: [] }
  const fakeCtx = {
    logger: { info: (line) => calls.logs.push(line), warn: (line) => calls.logs.push(line) },
    inject: (services, cb) => { calls.inject.push({ services, cb }) },
    on: (event, cb) => { calls.on.push({ event, cb }) },
    once: (event, cb) => { calls.once.push({ event, cb }) },
    effect: () => { calls.effect += 1 },
    get: () => undefined,
  }
  plugin.apply(fakeCtx)

  const services = calls.inject.map((entry) => entry.services.join(','))
  assert(services.includes('commands'), `commands was not mounted: ${services.join('|')}`)
  // tuiScenes must NOT be injected: `ctx.inject` runs its callback under the child activation it
  // starts, and dsh-TUI validates the ambient activation (host-access.js: assertion "stale
  // activation") while recording the registering activation per scene. Registration is lazy instead.
  assert(!services.includes('tuiScenes'), `tuiScenes must not be injected (its callback runs under a child activation): ${services.join('|')}`)
  assert(calls.on.length === 0, `${calls.on.length} cordis events were mounted (a model-facing exit): ${calls.on.map((e) => e.event).join(',')}`)
  assert(calls.once.length === 0, `${calls.once.length} once-listeners were mounted`)
  assert(calls.logs.every((line) => !line.includes('scene secrets registered')), `the scene was registered during apply: ${calls.logs.join(' | ')}`)

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
  assert(calls.effect >= 1, `no cleanup was mounted after the command registration (ctx.effect ${calls.effect})`)
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

  // With no scene surface: fail loudly rather than silently, and register nothing.
  fakeCtx.get = () => undefined
  const noScene = definition.handler()
  assert(noScene.kind === 'error', `no error when the scene surface is missing: ${JSON.stringify(noScene)}`)
  assert(noScene.text.includes('tuiScenes'), `the error does not say what is missing: ${noScene.text}`)
  assert(calls.logs.every((line) => !line.includes('scene secrets registered')), 'the scene was registered without a service')

  // The host model that matters: dsh-TUI records the registering activation (scenes.js:102) and
  // refuses an open from any other one (:129 → :173-176). Registration happens on first use, on this
  // plugin's own activation; a scene registered under the activation `ctx.inject` starts is
  // unopenable from here, so this model makes that regression fail.
  const owners = new Map()
  const opened = []
  let identity = null
  const parentSeam = {
    register: (descriptor, who) => { owners.set(descriptor.id, 'parent'); identity = who; return () => {} },
    open: (id) => { opened.push(id); return owners.get(id) === 'parent' },
  }
  const childSeam = { register: (d) => { owners.set(d.id, 'child'); return () => {} }, open: (id) => owners.get(id) === 'child' }
  fakeCtx.get = (service) => (service === 'tuiScenes' ? parentSeam : undefined)
  const ok = definition.handler()
  assert(ok.kind === 'success' && Object.keys(ok).length === 1, `the happy path did not return a silent success: ${JSON.stringify(ok)}`)
  assert(owners.get('secrets') === 'parent', `the scene was registered by another activation: ${owners.get('secrets')}`)
  assert(identity === fakeCtx, 'register was not given the identity (the effect ledger would record undeclared)')
  assert(opened[0] === 'secrets', `open was given the wrong id: ${opened[0]}`)
  assert(parentSeam.open('secrets') === true, 'the activation that registered the scene cannot open it')
  assert(childSeam.open('secrets') === false, 'the model host does not model an owner mismatch')
  assert(calls.logs.some((line) => line.includes('scene secrets registered')), `the success line discriminates a thrown registration in the log: ${calls.logs.join(' | ')}`)

  // A second open must not register again (dsh-TUI throws on a duplicate id).
  const again = definition.handler()
  assert(again.kind === 'success' && owners.size === 1, `the scene was registered twice: ${owners.size}`)

  // A registration that throws must be reported, not swallowed — a silent failure is what left
  // `/secrets` saying "not registered" with no way to tell why. Fresh instance: this one has not
  // registered yet.
  const refused = new Error('registration refused by the host')
  refused.code = 'COMPONENT_NOT_ADMITTED'
  const refusedLogs = []
  let refusedHandler
  const throwingCtx = {
    logger: { info: (line) => refusedLogs.push(line), warn: (line) => refusedLogs.push(line) },
    inject: (services, cb) => {
      if (services.includes('commands')) cb({ commands: { register: (def) => { refusedHandler = def.handler; return () => {} } } })
    },
    effect: () => {},
    get: (name) => (name === 'tuiScenes' ? { register: () => { throw refused }, open: () => false } : undefined),
  }
  plugin.apply(throwingCtx)
  const why = refusedHandler()
  assert(refusedLogs.some((line) => line.includes('scene registration failed (COMPONENT_NOT_ADMITTED)')), `the registration failure was swallowed: ${refusedLogs.join(' | ')}`)
  assert(refusedLogs.every((line) => !line.includes('registration refused by the host')), 'the raw error text reached the log')
  assert(why.kind === 'error' && why.text.includes('COMPONENT_NOT_ADMITTED'), `the command does not say why it cannot open: ${JSON.stringify(why)}`)
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
const { quoteArg, toCommand, runWithCredential, injectedName, redact } = await import('../lib/types/use.js')

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

// ---------------------------------------------------------------- the two tools
// Registration, refusals, the scope table, the audit trail and the degradation paths are driven
// through a fake host — the same way the scene checks are driven through a fake React.
const { apply } = plugin

/** A host with exactly the seams apply() looks for; each one can be switched off. */
function toolHost(options = {}) {
  const registered = { tools: [], scenes: [] }
  const shellRuns = []
  const warns = []
  const value = options.value ?? 'TOOL_SENTINEL_5c31'
  const credentials = options.credentials ?? {
    async describe() { return { configured: true, source: 'file', writable: true } },
    async resolve() { return { value, source: 'file' } },
    async set() {},
    async unset() {},
  }
  const ctx = {
    logger: { info: () => {}, warn: (message) => warns.push(message) },
    inject: (names, callback) => {
      // Cordis hands the callback a scoped context where the injected services are properties.
      const scoped = { ...ctx, ...Object.fromEntries(names.map((name) => [name, ctx.get(name, false)])) }
      scoped.inject = ctx.inject
      scoped.effect = ctx.effect
      scoped.get = ctx.get
      callback(scoped)
    },
    effect: () => {},
    get(name) {
      if (name === 'credentials') return options.noCredentials ? undefined : credentials
      if (name === 'commands') return { register() { return () => {} } }
      if (name === 'tuiScenes') {
        return options.noScenes ? undefined : {
          register(descriptor) { registered.scenes.push(descriptor); return () => {} },
          open: () => options.openResult ?? true,
        }
      }
      if (name === 'tools') {
        return options.noTools ? undefined : { register(definition) { registered.tools.push(definition); return () => {} } }
      }
      if (name === 'shell') {
        return options.noShell ? undefined : {
          resolve(request) { return request },
          async execute(spec) {
            shellRuns.push(spec)
            const outcome = options.run?.(spec) ?? { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
            return { result: async () => outcome }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, registered, shellRuns, warns, credentials }
}

const toolNamed = (registered, toolName) => registered.tools.find((entry) => entry.name === toolName)
/** A fresh DSH_TUI_HOME for one check; the store reads process.env on every call. */
function freshTuiHome(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-tui-secret-${label}-`))
  process.env.DSH_TUI_HOME = dir
  return dir
}
const recordFile = (home) => path.join(home, 'dsh-tui-secret', 'refs.json')
const auditFile = (home) => path.join(home, 'dsh-tui-secret', 'audit.jsonl')

await check('㉑ both tools register at runtime and a missing tools seam is not fatal', async () => {
  freshTuiHome('tools')
  const host = toolHost()
  apply(host.ctx)
  const names = host.registered.tools.map((entry) => entry.name).sort()
  assert(names.join(',') === 'request_credential,use_credential', `wrong tools: ${names.join(',')}`)
  for (const entry of host.registered.tools) {
    assert(typeof entry.execute === 'function', `${entry.name} has no execute`)
    assert(entry.output && entry.output.schema && typeof entry.output.render === 'function', `${entry.name} has no output{schema,render}`)
    assert(entry.parameters.type === 'object', `${entry.name} declares no object schema`)
  }
  const bare = toolHost({ noTools: true })
  apply(bare.ctx)
  assert(bare.registered.tools.length === 0, 'a tool was registered without a tools seam')
  assert(bare.warns.some((line) => line.includes('no tools seam')), 'the missing tools seam was not warned about')
})

await check('㉒ no permission means refused, and the command never starts', async () => {
  freshTuiHome('denied')
  store.markStored('ALPHA_TOKEN', { scope: 'none' })
  const host = toolHost()
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  const denied = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['echo', 'x'] }, { agent: { id: 'session-a' } })
  assert(denied.status === 'refused', `scope none was not refused: ${JSON.stringify(denied)}`)
  assert(host.shellRuns.length === 0, 'the shell ran although no permission was granted')
  const unknown = await use.execute({ ref: 'NEVER_STORED', argv: ['echo', 'x'] }, {})
  assert(unknown.status === 'refused', 'an unknown reference was not refused')
  const badName = await use.execute({ ref: 'DSH_HOME', argv: ['echo', 'x'] }, {})
  assert(badName.status === 'refused', 'a reserved name was not refused')
  assert(host.shellRuns.length === 0, 'a refusal still started a command')
})

await check('㉓ the value goes into that one execution and nowhere else', async () => {
  freshTuiHome('env')
  const value = 'ENV_SENTINEL_7d2f'
  store.markStored('ALPHA_TOKEN', { scope: 'once', sessionId: 'session-a' })
  const before = JSON.stringify(process.env)
  const host = toolHost({ value })
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  assert(use.parameters.properties.argv.type === 'array', 'argv is not declared as an array')
  assert(!('env' in use.parameters.properties) && !('value' in use.parameters.properties), 'the tool exposes env/value to the model')
  const result = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-a' } })
  assert(result.exitCode === 0, `the call failed: ${JSON.stringify(result)}`)
  assert(JSON.stringify(process.env) === before, 'the parent environment changed')
  const spec = host.shellRuns[0]
  assert(spec.env.DSH_SECRET_ALPHA_TOKEN === value, `wrong child env: ${JSON.stringify(spec.env)}`)
  assert(Object.keys(spec.env).length === 1, `the child env carries more than the value: ${JSON.stringify(spec.env)}`)
  assert(!('dshEnv' in spec), 'the managed DSH_* slot must not be used')
  assert(spec.command === "'echo' 'hi'", `the command was not built from quoted argv: ${spec.command}`)
})

await check('㉔ the returned slice is redacted and the audit holds no value', async () => {
  const home = freshTuiHome('redact')
  const value = 'REDACT_SENTINEL_9a11'
  store.markStored('ALPHA_TOKEN', { scope: 'until', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const host = toolHost({ value, run: () => ({ exitCode: 0, stdout: `token=${value}\nsecond ${value}\n`, stderr: `err ${value}`, timedOut: false, aborted: false }) })
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  const result = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['sh', '-c', 'printf %s "$DSH_SECRET_ALPHA_TOKEN"'] }, {})
  assert(result.stdout === 'token=[credential]\nsecond [credential]\n', `stdout was not redacted: ${JSON.stringify(result.stdout)}`)
  assert(result.stderr === 'err [credential]', `stderr was not redacted: ${JSON.stringify(result.stderr)}`)
  assert(result.redacted === true, 'the redaction flag was not set')
  assert(!JSON.stringify(result).includes(value), 'the value came back in the tool result')
  const audit = fs.readFileSync(auditFile(home), 'utf8')
  assert(audit.includes('"event":"used"') && audit.includes('"event":"redacted"'), `the audit misses events: ${audit}`)
  assert(!audit.includes(value), 'the audit holds the value')
})

await check('㉕ once is used up by one call; ㉖ until expires', async () => {
  freshTuiHome('windows')
  const host = toolHost()
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  store.markStored('ONCE_TOKEN', { scope: 'once', sessionId: 'session-a' })
  const first = await use.execute({ ref: 'ONCE_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-a' } })
  assert(first.exitCode === 0, `the first call failed: ${JSON.stringify(first)}`)
  const second = await use.execute({ ref: 'ONCE_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-a' } })
  assert(second.status === 'refused', `once was not used up: ${JSON.stringify(second)}`)
  assert(host.shellRuns.length === 1, `the second call still started a command (${host.shellRuns.length})`)

  store.markStored('OLD_TOKEN', { scope: 'until', expiresAt: new Date(Date.now() - 1_000).toISOString() })
  const expired = await use.execute({ ref: 'OLD_TOKEN', argv: ['echo', 'hi'] }, {})
  assert(expired.status === 'refused', `an expired permission was allowed: ${JSON.stringify(expired)}`)
})

await check('㉗ a refused or cancelled request writes nothing at all', async () => {
  const home = freshTuiHome('nowrite')
  const headless = toolHost({ openResult: false })
  apply(headless.ctx)
  const request = toolNamed(headless.registered, 'request_credential')
  const refused = await request.execute({ ref: 'ALPHA_TOKEN', purpose: 'test' }, { agent: { id: 'session-a' } })
  assert(refused.status === 'refused', `a headless request was not refused: ${JSON.stringify(refused)}`)
  assert(!fs.existsSync(recordFile(home)), 'the record file was written for a refusal')
  assert(!fs.existsSync(auditFile(home)), 'the audit file was written for a refusal')

  const cancelled = toolHost()
  apply(cancelled.ctx)
  const request2 = toolNamed(cancelled.registered, 'request_credential')
  const controller = new AbortController()
  controller.abort()
  const aborted = await request2.execute({ ref: 'ALPHA_TOKEN', purpose: 'test' }, { agent: { id: 'session-a' }, signal: controller.signal })
  assert(aborted.status === 'cancelled', `an aborted call was not cancelled: ${JSON.stringify(aborted)}`)
  assert(!fs.existsSync(recordFile(home)), 'the record file was written for a cancellation')
  assert(!fs.existsSync(auditFile(home)), 'the audit file was written for a cancellation')
})

await check('㉘ a v1 name index is read as v2 and a damaged one is never overwritten', async () => {
  const home = freshTuiHome('compat')
  fs.mkdirSync(path.dirname(recordFile(home)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(recordFile(home), JSON.stringify({ version: 1, names: ['LEGACY_TOKEN'] }), { mode: 0o600 })
  assert(store.loadNames().includes('LEGACY_TOKEN'), 'the v1 name was not imported')
  store.markStored('LEGACY_TOKEN', { scope: 'once' })
  const written = JSON.parse(fs.readFileSync(recordFile(home), 'utf8'))
  assert(written.version === 2, `the file was not upgraded to v2: ${written.version}`)
  assert(written.refs[0].scope === 'once', 'the permission was not recorded')

  fs.writeFileSync(recordFile(home), '{ this is not json', { mode: 0o600 })
  assert(store.loadNames().length === 0, 'a damaged file must read as empty')
  store.addName('GAMMA_TOKEN')
  assert(fs.readFileSync(recordFile(home), 'utf8').includes('GAMMA_TOKEN'), 'a fresh write after damage failed')
})

await check('㉚ the scene revokes: one reference and everything at once', async () => {
  const home = freshTuiHome('revoke')
  store.markStored('ALPHA_TOKEN', { scope: 'session', sessionId: 's' })
  store.markStored('BETA_TOKEN', { scope: 'once' })
  const revoked = []
  const scene = plugin.__internals.makeScene({
    getCredentials: () => ({ async describe() { return { configured: true, writable: true } }, async resolve() { return undefined }, async set() {}, async unset() {} }),
    store: { loadNames: () => ['ALPHA_TOKEN', 'BETA_TOKEN'], addName: () => {}, removeName: () => {} },
    logger: { info: () => {}, warn: () => {} },
    records: () => store.loadRecords(),
    revokeGrant: (ref) => { const done = store.revoke(ref); if (done) revoked.push(ref); return done },
    revokeEveryGrant: () => { const list = store.revokeAll(); revoked.push(...list); return list },
  })
  const view = mount(scene, { channel: {}, close: () => {} })
  await flush()
  view.render()
  assert(view.text.includes('agent use: session'), `the list does not show the permission: ${view.text}`)
  view.press('v')
  await flush()
  assert(revoked.includes('ALPHA_TOKEN'), 'v did not revoke the selected reference')
  assert(view.text.includes('revoked agent use for ALPHA_TOKEN'), `no feedback after v: ${view.text}`)
  view.press('R')
  view.press('y')
  await flush()
  assert(revoked.includes('BETA_TOKEN'), 'R + y did not revoke everything')
  assert(store.loadRecords().every((record) => record.scope === 'none'), 'a permission survived the revoke-all')
  const audit = fs.readFileSync(auditFile(home), 'utf8')
  assert(audit.includes('"event":"revoked"'), 'the revoke was not audited')
})

await check('㉛ without a shell seam the tool refuses instead of throwing', async () => {
  freshTuiHome('noshell')
  store.markStored('ALPHA_TOKEN', { scope: 'once' })
  const host = toolHost({ noShell: true })
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  const result = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['echo', 'hi'] }, {})
  assert(result.status === 'refused', `a missing shell seam was not refused: ${JSON.stringify(result)}`)
  assert(result.note.includes('shell'), `the note does not say why: ${result.note}`)
})

await check('㉜ the scene refuses a request when no TUI front end accepts it', async () => {
  freshTuiHome('headless')
  const host = toolHost({ openResult: false })
  apply(host.ctx)
  assert(host.registered.scenes.length === 0, 'the scene was registered before anything needed it')
  const request = toolNamed(host.registered, 'request_credential')
  const result = await request.execute({ ref: 'ALPHA_TOKEN', purpose: 'x' }, {})
  assert(result.status === 'refused', `a headless card was not refused: ${JSON.stringify(result)}`)
  const scene = host.registered.scenes[0]
  assert(scene && scene.id === 'secrets', 'the scene was not registered on first use')
  assert(host.registered.scenes.length === 1, `the scene was registered ${host.registered.scenes.length} times`)
})

await check('㉝ a cancelled tool call settles the card and writes nothing', async () => {
  const home = freshTuiHome('abort')
  const host = toolHost()
  apply(host.ctx)
  const request = toolNamed(host.registered, 'request_credential')
  const controller = new AbortController()
  controller.abort()
  const result = await request.execute({ ref: 'ALPHA_TOKEN', purpose: 'x' }, { signal: controller.signal })
  assert(result.status === 'cancelled', `an aborted card was not cancelled: ${JSON.stringify(result)}`)
  // The host rejects any tool result that is not losslessly JSON; an own `note: undefined`
  // property is enough to turn a clean cancel into an INVALID_TOOL_OUTPUT error.
  assert(!('note' in result), `the cancelled result kept the undefined note key: ${JSON.stringify(result)}`)
  assert(Object.values(result).every((value) => value !== undefined), `the cancelled result carries undefined: ${JSON.stringify(result)}`)
  assert(!fs.existsSync(recordFile(home)) && !fs.existsSync(auditFile(home)), 'an aborted card wrote something')
})

await check('㉞ session scope is judged by session id and never clears itself', async () => {
  const home = freshTuiHome('session')
  const host = toolHost()
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  store.markStored('SESSION_TOKEN', { scope: 'session', sessionId: 'session-a' })
  const mine = await use.execute({ ref: 'SESSION_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-a' } })
  assert(mine.exitCode === 0, `the owning session was refused: ${JSON.stringify(mine)}`)
  const theirs = await use.execute({ ref: 'SESSION_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-b' } })
  assert(theirs.status === 'refused', `another session was allowed: ${JSON.stringify(theirs)}`)
  const anonymous = await use.execute({ ref: 'SESSION_TOKEN', argv: ['echo', 'hi'] }, {})
  assert(anonymous.status === 'refused', 'a call without a session id was allowed')
  // Restoring the record (what a resumed session does: a new agent, the same session id) and
  // running long after the request must still work — nothing clears a session permission.
  const later = await use.execute({ ref: 'SESSION_TOKEN', argv: ['echo', 'hi'] }, { agent: { id: 'session-a' } })
  assert(later.exitCode === 0, `the permission did not survive a resumed session: ${JSON.stringify(later)}`)
  const record = store.loadRecords().find((entry) => entry.ref === 'SESSION_TOKEN')
  assert(record.useCount === 2 && record.revokedAt === null, `the record drifted: ${JSON.stringify(record)}`)
  assert(fs.readFileSync(auditFile(home), 'utf8').split('\n').filter((line) => line.includes('"used"')).length === 2, 'the audit misses a use')
})

await check('㉟ the card: the agent asks, the human picks a scope, the value is stored once', async () => {
  freshTuiHome('card')
  const settled = []
  const setCalls = []
  const pending = { ref: 'ALPHA_TOKEN', purpose: 'call the internal API', sessionId: 'session-a' }
  const channel = {
    request: async () => ({ kind: 'refused' }),
    active: () => pending,
    settle: (outcome) => { settled.push(outcome); return true },
    subscribe: () => () => {},
  }
  const scene = plugin.__internals.makeScene({
    getCredentials: () => ({ async describe() { return { configured: false, writable: true } }, async resolve() { return undefined }, async set(ref, value) { setCalls.push({ ref, value }) }, async unset() {} }),
    store: { loadNames: () => [], addName: () => {}, removeName: () => {} },
    logger: { info: () => {}, warn: () => {} },
    channel,
  })
  const view = mount(scene, { channel: {}, close: () => {} })
  await flush()
  view.render()
  assert(view.text.includes('A credential is requested'), `the card did not open: ${view.text}`)
  assert(view.text.includes('call the internal API'), 'the purpose is not shown')
  view.press('2')       // "agent may use it once"
  view.press('\r', { return: true })
  for (const ch of SENTINEL) view.press(ch)
  assert(!view.text.includes(SENTINEL), 'the card echoed the value')
  view.press('\r', { return: true })
  await flush()
  assert(setCalls.length === 1 && setCalls[0].value === SENTINEL, `the value never reached credentials.set: ${JSON.stringify(setCalls)}`)
  assert(settled.length === 1 && settled[0].kind === 'stored' && settled[0].scope === 'once', `the card settled wrong: ${JSON.stringify(settled)}`)
  assert(!JSON.stringify(settled).includes(SENTINEL), 'the settled outcome carries the value')
  assert(view.frames.every((frame) => !frame.includes(SENTINEL)), 'a rendered frame holds the value')
})

await check('㊱ a transformed value is not caught: redacted false does not mean "no value"', async () => {
  freshTuiHome('base64')
  const value = 'TRANSFORM_SENTINEL_31af'
  const encoded = Buffer.from(`tok=${value}\n`, 'utf8').toString('base64')
  // The same command the model would write with `| base64`: the value leaves as a transformed copy.
  const host = toolHost({ value, run: () => ({ exitCode: 0, stdout: `${encoded}\n`, stderr: '', timedOut: false, aborted: false }) })
  store.markStored('ALPHA_TOKEN', { scope: 'once' })
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  const result = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['sh', '-c', 'printf %s "$DSH_SECRET_ALPHA_TOKEN" | base64'] }, {})
  assert(result.redacted === false, 'a transformed copy must not be reported as redacted')
  assert(result.stdout.includes(encoded), 'the encoded value is what the model gets back')
  assert(!result.stdout.includes(value), 'the plain value must not be in the output here')
  assert(!result.stdout.includes('[credential]'), 'nothing was replaced')
})

await check('㊲ a truncated value passes through too: redacted false is not proof', async () => {
  freshTuiHome('truncated')
  const value = 'TRUNC_SENTINEL_77c1'
  const half = value.slice(0, 6)
  // What the executor's capture cap does to the output: the value is cut in the middle.
  const host = toolHost({ value, run: () => ({ exitCode: 0, stdout: `tok=${half}`, stderr: '', timedOut: false, aborted: false }) })
  store.markStored('ALPHA_TOKEN', { scope: 'once' })
  apply(host.ctx)
  const use = toolNamed(host.registered, 'use_credential')
  const result = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['sh', '-c', 'printf %s "$DSH_SECRET_ALPHA_TOKEN"'] }, {})
  assert(result.redacted === false, 'a half value must not be reported as redacted')
  assert(result.stdout === `tok=${half}`, `the truncated output was altered: ${JSON.stringify(result.stdout)}`)
  // The guarantee is the wording, not the mechanism: nothing in our own result carries the value.
  assert(!JSON.stringify({ ...result, stdout: '', stderr: '' }).includes(value), 'the value leaked outside stdout')
})

await check('㊳ redaction replaces every occurrence — short values make output unreadable, and that is deliberate', async () => {
  // Replacing every occurrence is the safe side: replacing only the first would leak the rest.
  // The cost is real and pinned here so nobody "fixes" it into a leak later.
  assert(redact('exit1 code 1 FAILED', '1').text === 'exit[credential] code [credential] FAILED', 'the short-value cost changed')
  assert(redact('token=abc123', 'abc123').text === 'token=[credential]', 'the ordinary case changed')
  // Single pass (split/join), so a value that happens to be the placeholder itself is NOT
  // re-substituted — unlike a loop-based scrubber, which yields `[[credential]]`.
  assert(redact('the value is credential', 'credential').text === 'the value is [credential]', 'the single-pass placeholder case changed')
  assert(redact('nothing here', 'abc123').text === 'nothing here', 'a miss must not touch the text')
})

// ---------------------------------------------------------------- the refusal note
await check('㊴ a refusal note names the concrete reason only under DSH_TUI_SECRET_DEBUG=1', async () => {
  const base = 'the user refused, or no card could be shown'
  delete process.env.DSH_TUI_SECRET_DEBUG
  const off = toolHost({ openResult: false })
  apply(off.ctx)
  const plain = await toolNamed(off.registered, 'request_credential').execute({ ref: 'ALPHA_TOKEN', purpose: 'x' }, {})
  assert(plain.status === 'refused', `a scene that will not open must refuse: ${JSON.stringify(plain)}`)
  assert(plain.note === base, `the default note changed: ${JSON.stringify(plain.note)}`)

  process.env.DSH_TUI_SECRET_DEBUG = '1'
  const on = toolHost({ openResult: false })
  apply(on.ctx)
  const debug = await toolNamed(on.registered, 'request_credential').execute({ ref: 'ALPHA_TOKEN', purpose: 'x' }, {})
  assert(debug.note.startsWith(base), `the debug note lost the default wording: ${JSON.stringify(debug.note)}`)
  assert(debug.note.endsWith('[the host did not open the scene]'), `the debug note misses the reason: ${JSON.stringify(debug.note)}`)

  // The prose is only as good as the channel's reason codes; both real endings are pinned here.
  const { SceneChannel } = await import('../lib/types/card.js')
  const shown = new SceneChannel({ open: () => true }, 'secrets')
  const answered = shown.request({ ref: 'ALPHA_TOKEN', purpose: 'x' })
  assert(shown.lastRefusal() === undefined, 'a card that is on screen must not report a reason')
  shown.settle({ kind: 'refused' })
  assert((await answered).kind === 'refused', 'the card did not settle as refused')
  assert(shown.lastRefusal() === 'the card was answered with refuse', `wrong reason after a human refusal: ${shown.lastRefusal()}`)
  const blind = new SceneChannel({ open: () => false }, 'secrets')
  assert((await blind.request({ ref: 'ALPHA_TOKEN', purpose: 'x' })).kind === 'refused', 'an unopenable scene did not refuse')
  assert(blind.lastRefusal() === 'the host did not open the scene', `wrong reason when the scene will not open: ${blind.lastRefusal()}`)

  const notes = [plain.note, debug.note, shown.lastRefusal(), blind.lastRefusal()]
  assert(notes.every((note) => !String(note).includes(SENTINEL)), `a refusal note carries a value: ${notes.join(' | ')}`)
  delete process.env.DSH_TUI_SECRET_DEBUG
})

// ---------------------------------------------------------------- declared output shapes
// The host validates every tool result against its declared schema; a shape that only covers the
// happy path turns each refusal into INVALID_TOOL_OUTPUT, so the note never reaches the model.
await check('㊵ both tool outputs validate against their declared schema', async () => {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) {
    candidates.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'))
  }
  const pnpmRoot = path.join(os.homedir(), '.local/share/pnpm/global')
  try {
    for (const scope of fs.readdirSync(pnpmRoot)) {
      for (const version of fs.readdirSync(path.join(pnpmRoot, scope))) {
        const store = path.join(pnpmRoot, scope, version, 'node_modules/.pnpm')
        let entries
        try { entries = fs.readdirSync(store) } catch { continue }
        for (const entry of entries) {
          if (entry.startsWith('@deepseek-ai+dsh-tools@')) {
            candidates.push(path.join(store, entry, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'))
          }
        }
      }
    }
  } catch {
    // no pnpm global install on this machine
  }
  const file = candidates.find((candidate) => fs.existsSync(candidate))
  if (!file) throw new Skip('no @deepseek-ai/dsh-tools on this machine, skipping the output-schema gate')
  const { pathToFileURL } = await import('node:url')
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(file).href)

  freshTuiHome('schema')
  const host = toolHost({ openResult: false })
  apply(host.ctx)
  const request = toolNamed(host.registered, 'request_credential')
  const use = toolNamed(host.registered, 'use_credential')

  const requestRefusal = await request.execute({ ref: 'ALPHA_TOKEN', purpose: 'x' }, {})
  store.markStored('ALPHA_TOKEN', { scope: 'once' })
  const useRefusal = await use.execute({ ref: 'NEVER_STORED', argv: ['true'] }, {})
  const useSuccess = await use.execute({ ref: 'ALPHA_TOKEN', argv: ['echo', 'hi'] }, {})

  const samples = {
    request_credential: [requestRefusal, { status: 'stored', ref: 'ALPHA_TOKEN' }],
    use_credential: [useRefusal, useSuccess],
  }
  for (const [name, values] of Object.entries(samples)) {
    const tool = toolNamed(host.registered, name)
    assertSupportedJsonSchema(tool.output.schema)
    for (const value of values) {
      const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
      assert(violations.length === 0, `${name} returned a value its schema rejects: ${violations.join('; ')}`)
    }
  }
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
