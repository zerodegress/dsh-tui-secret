// 验收脚本：两层证据。
//   ① 场景侧哨兵验证：证明「值只进 ctx.credentials，别的面一个字节都看不到」。
//   ② bin 侧写盘验证：证明它和 provider 共用一把锁、只做行级 upsert、缺前提一律 fail-closed。
//
// 做法不是读源码找茬，而是**真的把场景跑起来**：这里实现一份最小 React hook runtime
// 与 ui kit 替身，按真人按键顺序驱动场景（a → 名字 → Enter → 值 → Enter），
// 全程记录每一帧渲染出的字符串、每一条日志、每一次对外调用，最后对哨兵值做 grep。
// 命中只允许出现在一处：被 mock 的 credentials.set 收到的那次写入。
//
// 覆盖的四个「可能泄漏面」：
//   - tool-result / tool-card / llm-stream：本插件不注册任何工具、不挂任何
//     ctx.on('tools/execute' | 'llm/stream')，这三面在结构上不存在（第 ⑧ 组直接
//     断言 ctx.on/ctx.once 一次都没被调用，命令 handler 的返回值里也没有值）。
//   - plugin-log：把 ctx.logger 换成记录器逐条 grep（第 ④ 组）。
//
// 它**不能**证明的东西（别把这份脚本当全案）：
//   - 不能替代真机 TTY 手测：真终端里的回滚缓冲、终端录像、宿主自身日志不在这里。
//   - 不覆盖终端之外的写入方（Web 卡片、dsh CLI 自己写同一份凭据文件）。
//
// 用法：node scripts/verify.mjs   （npm test / npm run verify 同一入口）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// 名字清单落在隔离目录，绝不碰用户真实的 ~/.dsh-tui。
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-secret-verify-'))
process.env.DSH_TUI_HOME = SCRATCH

const SENTINEL = 'SENTINEL_p4ssw0rd_DO_NOT_LEAK_7f3a'
const SENTINEL2 = 'x9'

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

// ---------------------------------------------------------------- 最小 hook runtime
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
 * 把场景组件挂在一份持久的 hook 表上：render() 重新执行组件函数，
 * press() 调 useInput 捕获的 handler 再重新渲染——ink 的最小骨架。
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
    // 与 React 一样把「渲染 → effect 里同步 setState → 再渲染」跑到收敛
    let guard = 0
    do {
      dirty = false
      hooks.index = 0
      frames.push(collectStrings(component({ ...props, React, ui })).join('\n'))
    } while (dirty && (guard += 1) < 10)
  }
  // 与 React 一样：只有 state 变更才重绘；ref 改动不会让画面更新（这条是刻意的，
  // 掩码若只靠 ref 就会停在上一次画面上——真宿主渲染那关正是这么抓到的）。
  const press = (input, key = {}) => { handler(input, key); if (dirty) render() }

  render()
  return {
    frames,
    press,
    render,
    maskOf() { return this.text.match(/值：(\S*)/)?.[1] ?? '' },
    get text() { return frames[frames.length - 1] ?? '' },
  }
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------- 场景：只写一处
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

await check('① 空值被拒：Enter 不写盘', async () => {
  view.press('a')
  for (const ch of 'MY_TOKEN') view.press(ch)
  view.press('\r', { return: true })
  assert(view.text.includes('第 2 步'), `未进入值输入模式：${view.text}`)
  view.press('\r', { return: true })
  await flush()
  assert(setCalls.length === 0, `空值竟然调了 set（${setCalls.length} 次）`)
  assert(view.text.includes('值为空'), `没有提示值为空：${view.text}`)
})

await check('② 保留前缀被拒：DSH_ 开头不许录入', async () => {
  view.press('a')
  for (const ch of 'DSH_FOO') view.press(ch)
  view.press('\r', { return: true })
  assert(!view.text.includes('第 2 步'), 'DSH_ 前缀竟然进到了值输入')
  assert(view.text.includes('归宿主所有'), `没有给出保留前缀的理由：${view.text}`)
  view.press('\u001b', { escape: true }) // 回列表
})

const maskFrames = []
await check('③ 逐字掩码：屏幕上只有固定掩码，不漏值也不漏长度', async () => {
  view.press('a')
  for (const ch of 'MY_TOKEN') view.press(ch)
  view.press('\r', { return: true })
  assert(view.text.includes('第 2 步'), `未进入值输入模式：${view.text}`)
  for (const ch of SENTINEL) {
    view.press(ch)
    const frame = view.text
    maskFrames.push(frame)
    assert(!frame.includes(SENTINEL), '屏幕上出现了完整哨兵值')
    for (let i = 1; i < SENTINEL.length; i += 1) {
      assert(!frame.includes(SENTINEL.slice(0, i)), `屏幕回显了输入前缀 ${SENTINEL.slice(0, i)}`)
    }
  }
  const first = view.frames.find((frame) => frame.includes('值：•')) ? maskFrames[0] : null
  void first
  const masks = maskFrames.map((frame) => frame.match(/值：(\S*)/)?.[1] ?? '')
  assert(masks.every((mask) => mask === masks[0]), `掩码随长度变化：${JSON.stringify(masks)}`)
  assert(masks[0].includes('\u2022'), `掩码没画出来（ref 改动不触发重绘？当前是「${masks[0]}」）`)
  assert(!/\d/.test(masks[0]), `掩码里出现了数字（可能带长度）：${masks[0]}`)
})

await check('④ 值只到 credentials.set：渲染与日志零命中', async () => {
  view.press('\r', { return: true })
  await flush()
  view.render()
  assert(setCalls.length === 1, `set 调用次数应为 1，实际 ${setCalls.length}`)
  assert(setCalls[0].ref === 'MY_TOKEN', `引用名不对：${setCalls[0].ref}`)
  assert(setCalls[0].value === SENTINEL, 'set 收到的值不是输入的值')
  const frameHits = view.frames.filter((frame) => frame.includes(SENTINEL))
  assert(frameHits.length === 0, `${frameHits.length} 帧渲染结果含哨兵值`)
  const logHits = pluginLog.filter((line) => line.includes(SENTINEL))
  assert(logHits.length === 0, `日志含哨兵值：${logHits.join(' | ')}`)
  assert(pluginLog.some((line) => line.includes('MY_TOKEN')), `日志没记下引用名：${pluginLog.join(' | ')}`)
  assert(view.text.includes('已写入 MY_TOKEN'), `写入后的提示不对：${view.text}`)
})

await check('⑤ 短值（2 字符）同样不落屏', async () => {
  view.press('a')
  for (const ch of 'OTHER') view.press(ch)
  view.press('\r', { return: true })
  for (const ch of SENTINEL2) {
    view.press(ch)
    assert(!view.text.includes(SENTINEL2), '短值回显了')
  }
  view.press('\r', { return: true })
  await flush()
  view.render()
  assert(setCalls.length === 2, `第二次 set 没发生（${setCalls.length}）`)
  assert(view.frames.every((frame) => !frame.includes(SENTINEL2)), '某一帧里有短哨兵值')
})

await check('⑥ 删除要显式 y；别的键不删', async () => {
  view.press('d')
  assert(view.text.includes('确认删除'), `没进确认态：${view.text}`)
  view.press('x')
  await flush()
  assert(unsetCalls.length === 0, '按 x 竟然删了')
  assert(view.text.includes('确认删除'), '按 x 退出了确认态')
  view.press('y')
  await flush()
  view.render()
  assert(unsetCalls.length === 1, `unset 调用次数应为 1，实际 ${unsetCalls.length}`)
})

await check('⑥b credentials 缺失时：删除不谎报成功', async () => {
  const noService = makeScene({
    getCredentials: () => undefined,
    store: { loadNames: () => ['GONE'], addName: () => {}, removeName: () => {} },
    logger: { info: () => {}, warn: () => {} },
  })
  const v = mount(noService, { channel: {}, close: () => {} })
  v.press('d')
  assert(v.text.includes('确认删除'), `没进确认态：${v.text}`)
  v.press('y')
  await flush()
  v.render()
  assert(!v.text.includes('已删除'), `服务缺失却报了已删除：${v.text}`)
  assert(v.text.includes('未删除') || v.text.includes('不可用'), `没说明原因：${v.text}`)
})

await check('⑦ Esc 关屏', async () => {
  view.press('\u001b', { escape: true })
  assert(closed === 1, `close() 调用次数 ${closed}`)
})

await check('⑧ 写失败只报错误码，不把值或原始错误文本带出去', async () => {
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
  assert(v.text.includes('EACCES'), `没有报错误码：${v.text}`)
  assert(!v.text.includes(SENTINEL), '错误提示里带出了值')
  assert(!v.frames.some((frame) => frame.includes(SENTINEL)), '有帧含哨兵')
  assert(!logs.some((line) => line.includes(SENTINEL)), `日志带出了原始错误文本：${logs.join(' | ')}`)
})

// ---------------------------------------------------------------- 挂载面：没有模型侧出口
await check('⑨ apply 只碰两个接缝，不挂任何模型侧 hook', async () => {
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
  assert(services.includes('tuiScenes'), `没挂 tuiScenes：${services.join('|')}`)
  assert(services.includes('commands'), `没挂 commands：${services.join('|')}`)
  assert(calls.on.length === 0, `挂了 ${calls.on.length} 个 cordis 事件（模型侧出口）：${calls.on.map((e) => e.event).join(',')}`)
  assert(calls.once.length === 0, `挂了 ${calls.once.length} 个一次性事件`)

  const registered = []
  calls.inject.find((entry) => entry.services.includes('tuiScenes')).cb({
    tuiScenes: { register: (descriptor, identity) => { registered.push({ descriptor, identity }); return () => {} } },
  })
  assert(calls.effect >= 1, `场景注册后没挂清理（ctx.effect ${calls.effect} 次）`)
  assert(registered.length === 1, '场景没注册')
  assert(registered[0].descriptor.id === 'secrets', `场景 id 不是 secrets：${registered[0].descriptor.id}`)
  assert(typeof registered[0].descriptor.component === 'function', '场景没有组件')
  assert(registered[0].identity === fakeCtx, 'register 没带 identity（效果台账会记成 undeclared）')

  // 命令面：托管面优先（带归属），缺失/失败时退回直注册
  const commandCb = calls.inject.find((entry) => entry.services.includes('commands')).cb
  const attributed = []
  fakeCtx.get = (service) => (service === 'tuiPluginHost'
    ? { registerCommand: (pluginCtx, def) => { attributed.push({ pluginCtx, def }); return () => {} } }
    : undefined)
  let direct = 0
  const commandServices = { commands: { register: () => { direct += 1; return () => {} } } }
  commandCb(commandServices)
  assert(calls.effect >= 2, `命令注册后没挂清理（ctx.effect ${calls.effect} 次）`)
  assert(attributed.length === 1, `没走托管面（attributed ${attributed.length}）`)
  assert(attributed[0].pluginCtx === fakeCtx, '托管面没收到本插件的 ctx')
  assert(direct === 0, '走了托管面还重复直注册')

  // 托管面注册失败 → 退回直注册，命令不能因此消失
  fakeCtx.get = (service) => (service === 'tuiPluginHost'
    ? { registerCommand: () => { const error = new Error('denied'); error.code = 'PERMISSION_NOT_GRANTED'; throw error } }
    : undefined)
  commandCb(commandServices)
  assert(direct === 1, `托管面失败后没退回直注册（direct ${direct}）`)

  let definition = attributed[0].def
  assert(definition?.name === 'secrets', `命令名不是 secrets：${definition?.name}`)
  assert(!JSON.stringify(definition.description).includes(SENTINEL), '命令描述里带着哨兵')

  // 场景服务缺失时：明确报错，不静默
  fakeCtx.get = () => undefined
  const noScene = definition.handler()
  assert(noScene.kind === 'error', `场景面缺失时没报错：${JSON.stringify(noScene)}`)
  assert(noScene.text.includes('tuiScenes'), `报错没指明缺什么：${noScene.text}`)

  // 场景面在但 id 没注册：open 返回 false，照样明确报错
  const opened = []
  fakeCtx.get = () => ({ open: (id) => { opened.push(id); return true } })
  const ok = definition.handler()
  assert(ok.kind === 'success', `正常路径没返回静默 success：${JSON.stringify(ok)}`)
  assert(Object.keys(ok).length === 1, `success 结果带了内容：${JSON.stringify(ok)}`)
  assert(opened[0] === 'secrets', `open 的 id 不对：${opened[0]}`)
  fakeCtx.get = () => ({ open: () => false })
  assert(definition.handler().kind === 'error', 'open 返回 false 时没报错')
})

// ---------------------------------------------------------------- 名字清单
await check('⑩ 名字清单只有名字；文件 0600、目录 0700', async () => {
  store.addName('MY_TOKEN')
  store.addName('OTHER')
  const file = path.join(SCRATCH, 'dsh-tui-secret', 'refs.json')
  const raw = fs.readFileSync(file, 'utf8')
  assert(!raw.includes(SENTINEL) && !raw.includes(SENTINEL2), '名字清单里出现了值')
  const names = store.loadNames()
  assert(names.includes('MY_TOKEN') && names.includes('OTHER'), `名字没落盘：${names.join(',')}`)
  assert((fs.statSync(file).mode & 0o777) === 0o600, `refs.json 权限 ${(fs.statSync(file).mode & 0o777).toString(8)}，应为 600`)
  assert((fs.statSync(path.dirname(file)).mode & 0o777) === 0o700, `目录权限 ${(fs.statSync(path.dirname(file)).mode & 0o777).toString(8)}，应为 700`)
})

await check('⑪ 名字清单损坏时不覆盖、不炸', async () => {
  const file = path.join(SCRATCH, 'dsh-tui-secret', 'refs.json')
  fs.writeFileSync(file, '{ this is not json')
  assert(store.loadNames().length === 0, '损坏文件应读出空表')
  assert(fs.readFileSync(file, 'utf8') === '{ this is not json', '损坏文件被覆盖了')
})

// ---------------------------------------------------------------- 真宿主渲染
// 上一组用的是自写的假 runtime；这一组换成**宿主自己的 React 与 ink**：
// 元素符号、hook dispatcher、渲染路径都是真的，能抓到假 runtime 抓不到的东西
// （这一组就是抓出「掩码只靠 ref 改动、画面不重绘」那个 bug 的）。
// 依赖本机装了 dsh-tui profile；没装就 SKIP，不算失败。
await check('⑫ 真宿主渲染（真实 React + 真实 ink）：掩码随输入重绘、值不落屏', async () => {
  const profile = process.env.DSH_TUI_PROFILE ?? path.join(os.homedir(), '.dsh/profiles/dsh-tui')
  const pkg = path.join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/ui.js')
  const reactEntry = path.join(profile, 'node_modules/react/index.js')
  if (!fs.existsSync(pkg) || !fs.existsSync(reactEntry)) {
    throw new Skip(`没装 dsh-tui profile（${profile}），跳过真宿主渲染`)
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
  stdout.isTTY = false // 非 TTY：ink 每帧整屏输出，不再只写差分，便于逐帧 grep
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
    assert(out.includes('ALPHA'), '首帧没有渲染列表')
    await tap('a')
    assert(out.includes('第 1 步'), '没进名字输入')
    for (const ch of 'MY_TOKEN') await tap(ch)
    await tap('\r', { return: true })
    assert(out.includes('第 2 步'), '没进值输入')

    const masks = []
    for (const ch of SENTINEL) {
      await tap(ch)
      assert(!out.includes(SENTINEL), '真宿主渲染里出现了哨兵值')
      for (let i = 1; i < SENTINEL.length; i += 1) {
        assert(!out.includes(SENTINEL.slice(0, i)), `真宿主渲染回显了前缀 ${SENTINEL.slice(0, i)}`)
      }
      masks.push(frame().match(/值：(\S*)/)?.[1] ?? '')
    }
    assert(masks.every((mask) => mask === masks[0]), `掩码随长度变化：${JSON.stringify(masks)}`)
    assert(masks[0].includes('\u2022'), `掩码没画出来（ref 改动不触发重绘？当前是「${masks[0]}」）`)
    assert(!/\d/.test(masks[0]), `掩码里出现数字：${masks[0]}`)

    await tap('\r', { return: true })
    await tick()
    assert(calls.length === 1 && calls[0].value === SENTINEL, '值没到 credentials.set')
    assert(!out.includes(SENTINEL), '写入后某一帧出现了哨兵值')
  } finally {
    instance.unmount()
  }
})

// ---------------------------------------------------------------- bin（同一份代码的另一半）
const CLI_PATH = new URL('../bin/dsh-tui-secret.mjs', import.meta.url).pathname

function cliRun(args, { home, tui, input }) {
  const env = { ...process.env, DSH_HOME: home, DSH_TUI_HOME: tui }
  delete env.DSH_TUI_PROFILE
  return spawnSync(process.execPath, [CLI_PATH, ...args], { input, encoding: 'utf8', env })
}

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-secret-cli-'))
  const tui = path.join(home, 'tui-home')
  fs.mkdirSync(tui, { recursive: true })
  return { home, tui, file: path.join(home, '.credentials.yaml') }
}

function seedCredentials(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

/** 用宿主装的 yaml 包解析，证明 provider 读回来的值就是我们写进去的那个。 */
async function parseWithHostYaml(text) {
  const candidates = [
    path.join(os.homedir(), '.dsh/profiles/dsh-tui/node_modules/yaml/dist/index.js'),
    path.join(os.homedir(), '.bun/install/global/node_modules/yaml/dist/index.js'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) return undefined
  const { pathToFileURL } = await import('node:url')
  const { parse } = await import(pathToFileURL(found).href)
  return parse(text)
}

const CLI_SECRET = 'CLI_SENTINEL_do_not_leak_91bd'

await check('⑬ bin set：行级 upsert —— 注释、别人的键、块标量都原样留着', async () => {
  const { home, tui, file } = freshHome()
  const original = '# 保留注释\nALPHA: a\nPEM: |\n  line1\n  line2\n'
  seedCredentials(file, original)

  const result = cliRun(['set', 'BETA', '--from-stdin'], { home, tui, input: CLI_SECRET })
  assert(result.status === 0, `set 退出码 ${result.status}：${result.stderr}`)
  assert(!result.stdout.includes(CLI_SECRET) && !result.stderr.includes(CLI_SECRET), 'stdout/stderr 里出现了值')

  const after = fs.readFileSync(file, 'utf8')
  assert(after.includes('# 保留注释'), '注释被吃掉了')
  assert(after.includes('ALPHA: a'), '别的键被改写了')
  assert(after.includes('PEM: |\n  line1\n  line2\n'), '块标量被改写')
  assert(after.trimEnd().endsWith(`BETA: "${CLI_SECRET}"`), `新键没追加：${JSON.stringify(after)}`)
  assert((fs.statSync(file).mode & 0o777) === 0o600, `权限不是 600：${(fs.statSync(file).mode & 0o777).toString(8)}`)
  assert(!fs.existsSync(`${file}.lock`), '锁文件没清掉')
  assert(fs.readdirSync(home).every((name) => !name.endsWith('.tmp')), '留了临时文件')

  const parsed = await parseWithHostYaml(after)
  if (parsed === undefined) throw new Skip('没有可用的 yaml 包，跳过「provider 读回来一致」这一半')
  assert(parsed.BETA === CLI_SECRET, 'provider 解析出来的值不是我们写进去的')
  assert(parsed.ALPHA === 'a' && parsed.PEM === 'line1\nline2\n', '别人的键解析结果变了')
})

await check('⑭ bin set 覆盖同一个键：只换那一行，其余字节不变', async () => {
  const { home, tui, file } = freshHome()
  const original = '# c\nALPHA: a\nPEM: |\n  line1\n  line2\n'
  seedCredentials(file, original)
  assert(cliRun(['set', 'ALPHA', '--from-stdin'], { home, tui, input: 'first' }).status === 0, '第一次写失败')
  const once = fs.readFileSync(file, 'utf8')
  assert(cliRun(['set', 'ALPHA', '--from-stdin'], { home, tui, input: 'second' }).status === 0, '第二次写失败')
  const twice = fs.readFileSync(file, 'utf8')
  assert(once.split('\n').length === twice.split('\n').length, '覆盖写改变了行数（可能整份重写了）')
  assert(twice.includes('# c') && twice.includes('PEM: |\n  line1\n  line2\n'), '覆盖写动了别的键')
  assert(twice.includes('ALPHA: "second"'), `覆盖没生效：${JSON.stringify(twice)}`)
  assert(!twice.includes('first'), '旧值还在文件里')
})

await check('⑮ bin 与 provider 是同一把锁：占着锁就报错退出、不写', async () => {
  const { home, tui, file } = freshHome()
  seedCredentials(file, 'ALPHA: a\n')
  const lockPath = `${file}.lock`
  fs.writeFileSync(lockPath, '12345\n', { mode: 0o600, flag: 'wx' })
  try {
    const result = cliRun(['set', 'BETA', '--from-stdin'], { home, tui, input: CLI_SECRET })
    assert(result.status === 2, `占锁时退出码应为 2，实际 ${result.status}`)
    assert(result.stderr.includes('写锁'), `报错没说清是锁：${result.stderr}`)
    assert(result.stderr.includes(lockPath), `报错没给锁路径：${result.stderr}`)
    assert(fs.readFileSync(file, 'utf8') === 'ALPHA: a\n', '占锁时文件被改了')
  } finally {
    fs.rmSync(lockPath, { force: true })
  }

  // 用 provider 自己那把 withFileLock 再撞一次（装了才跑）
  const atomicEntry = [
    path.join(os.homedir(), '.bun/install/global/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'),
    path.join(os.homedir(), '.dsh/profiles/dsh-tui/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'),
  ].find((candidate) => fs.existsSync(candidate))
  if (atomicEntry === undefined) throw new Skip('没有 dsh-atomic-write，跳过「与真锁对撞」这一半')
  const { pathToFileURL } = await import('node:url')
  const { withFileLock } = await import(pathToFileURL(atomicEntry).href)
  await withFileLock(file, async () => {
    const result = cliRun(['set', 'BETA', '--from-stdin'], { home, tui, input: CLI_SECRET })
    assert(result.status === 2, `provider 占锁时退出码应为 2，实际 ${result.status}`)
    assert(fs.readFileSync(file, 'utf8') === 'ALPHA: a\n', 'provider 占锁时文件被改了')
  })
})

await check('⑯ bin fail-closed：不给来源 / 空值 / 保留前缀 / 被环境遮蔽 / 权限过宽，一律拒且不写', async () => {
  const { home, tui, file } = freshHome()
  seedCredentials(file, 'ALPHA: a\n')
  const before = fs.readFileSync(file, 'utf8')

  const noSource = cliRun(['set', 'BETA'], { home, tui, input: '' })
  assert(noSource.status === 2 && noSource.stderr.includes('--from-stdin'), `非 TTY 不给来源应拒绝：${noSource.status} ${noSource.stderr}`)
  assert(!noSource.stdout.includes('已写入'), '拒绝路径却报了成功')

  const empty = cliRun(['set', 'BETA', '--from-stdin'], { home, tui, input: '' })
  assert(empty.status === 2 && empty.stderr.includes('空值'), `空值应拒绝：${empty.stderr}`)

  const reserved = cliRun(['set', 'DSH_SOMETHING', '--from-stdin'], { home, tui, input: CLI_SECRET })
  assert(reserved.status === 2 && reserved.stderr.includes('宿主'), `DSH_ 前缀应拒绝：${reserved.stderr}`)

  const shadowed = cliRun(['set', 'ALPHA', '--from-stdin'], { home, tui, input: CLI_SECRET })
  assert(shadowed.status === 0, '没有遮蔽时正常写应当成功')
  seedCredentials(file, before)
  const envHome = { ...process.env, DSH_HOME: home, DSH_TUI_HOME: tui, SHADOW_ME: 'x' }
  const shadowRun = spawnSync(process.execPath, [CLI_PATH, 'set', 'SHADOW_ME', '--from-stdin'], { input: CLI_SECRET, encoding: 'utf8', env: envHome })
  assert(shadowRun.status === 2 && shadowRun.stderr.includes('遮蔽'), `环境遮蔽应拒绝：${shadowRun.status} ${shadowRun.stderr}`)

  fs.chmodSync(file, 0o644)
  const wide = cliRun(['set', 'BETA', '--from-stdin'], { home, tui, input: CLI_SECRET })
  assert(wide.status === 2 && wide.stderr.includes('chmod 600'), `权限过宽应拒绝：${wide.stderr}`)
  fs.chmodSync(file, 0o600)

  assert(fs.readFileSync(file, 'utf8') === before, 'fail-closed 路径里有一次真写盘')
})

await check('⑰ bin rm：缺 --yes 拒绝；给了只摘那一个键', async () => {
  const { home, tui, file } = freshHome()
  seedCredentials(file, '# c\nALPHA: a\nBETA: b\n')
  const refused = cliRun(['rm', 'BETA'], { home, tui })
  assert(refused.status === 2, `缺 --yes 应拒绝：${refused.status}`)
  assert(fs.readFileSync(file, 'utf8').includes('BETA: b'), '缺 --yes 却删了')

  const ok = cliRun(['rm', 'BETA', '--yes'], { home, tui })
  assert(ok.status === 0, `rm 失败：${ok.stderr}`)
  const after = fs.readFileSync(file, 'utf8')
  assert(!after.includes('BETA'), '键没删掉')
  assert(after.includes('# c') && after.includes('ALPHA: a'), '删一个键动了别的行')

  // 删到只剩注释：注释不丢（我们只摘键的 span）；键全没了但还有别的行时不会写成 {}
  assert(cliRun(['rm', 'ALPHA', '--yes'], { home, tui }).status === 0, '删第二个失败')
  assert(fs.readFileSync(file, 'utf8') === '# c\n', `只剩注释时应保留注释：${JSON.stringify(fs.readFileSync(file, 'utf8'))}`)

  // 没有注释时：删空与 provider 一样落 {}
  const bare = freshHome()
  seedCredentials(bare.file, 'ALPHA: a\n')
  assert(cliRun(['rm', 'ALPHA', '--yes'], { home: bare.home, tui: bare.tui }).status === 0, '删空失败')
  assert(fs.readFileSync(bare.file, 'utf8') === '{}\n', `删空后应为 {}：${JSON.stringify(fs.readFileSync(bare.file, 'utf8'))}`)
})

await check('⑱ bin list：只出名字与状态，任何输出里都没有值', async () => {
  const { home, tui, file } = freshHome()
  seedCredentials(file, `ALPHA: "${CLI_SECRET}"\n`)
  const plain = cliRun(['list'], { home, tui })
  assert(plain.status === 0, `list 失败：${plain.stderr}`)
  assert(plain.stdout.includes('ALPHA'), 'list 没列出键')
  assert(!plain.stdout.includes(CLI_SECRET), 'list 里出现了值')
  const json = cliRun(['list', '--json'], { home, tui })
  assert(json.status === 0, `list --json 失败：${json.stderr}`)
  assert(!json.stdout.includes(CLI_SECRET), 'json 输出里出现了值')
  const parsedJson = JSON.parse(json.stdout)
  assert(parsedJson[0]?.name === 'ALPHA' && parsedJson[0]?.state === '已配置', `json 形状不对：${json.stdout}`)
})

await check('⑲ bin set --dry-run：不落盘、不建锁', async () => {
  const { home, tui, file } = freshHome()
  seedCredentials(file, 'ALPHA: a\n')
  const result = cliRun(['set', 'BETA', '--from-stdin', '--dry-run'], { home, tui, input: CLI_SECRET })
  assert(result.status === 0, `dry-run 失败：${result.stderr}`)
  assert(result.stdout.includes('[dry-run]'), 'dry-run 没标出来')
  assert(!result.stdout.includes(CLI_SECRET), 'dry-run 打印了值')
  assert(fs.readFileSync(file, 'utf8') === 'ALPHA: a\n', 'dry-run 竟然写了盘')
  assert(!fs.existsSync(`${file}.lock`), 'dry-run 建了锁')
})

// ---------------------------------------------------------------- 汇总
const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  const tag = entry.skip ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${entry.label}${entry.ok && !entry.skip ? '' : `\n      ${entry.detail ?? ''}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} PASS · 哨兵 ${SENTINEL.length} 字符 · 临时目录 ${SCRATCH}`)
if (failed.length > 0) process.exitCode = 1
