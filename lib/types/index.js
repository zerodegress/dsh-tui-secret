// dsh-tui-secret —— 在 dsh-TUI 里安全录入密钥（值只走 ctx.credentials）。
//
// 插件契约（见 tui-profile 插件指南「插件契约」）：
//   - 包根导出 name / apply，无默认导出；
//   - 每个可配置键都有默认值，服务缺失时静默降级，绝不让 TUI 起不来；
//   - 资源清理走 ctx.effect(() => () => dispose())。
//
// 三个接缝的用法与理由：
//   - tuiScenes（接缝八）注册 `/secrets` 全屏场景：掩码录入必须在由我们渲染的
//     屏幕里做（宿主 0.16.0 的设置区块虽已声明 secret 字段，但设置屏尚未画掩码）。
//   - tuiScenes.open 由我们自己的 slash 命令触发；命令名走 config.entryCommand。
//   - credentials（dsh 核心服务）是唯一的写入面：resolve/describe/set/unset。
//     它没有 list()，所以「录过哪些名字」必须自己存（store.js，只存名字）。
import { describeNameProblem, initialiseName, loadNames, addName, removeName } from './store.js'

export const name = 'dsh-tui-secret'

/** 场景 id；kebab-case，全局唯一。 */
const SCENE_ID = 'secrets'

/** 导出给测试与文档：本插件声明的默认配置。 */
export const DEFAULTS = {
  /** 打开场景的 slash 命令名（不带斜杠）。 */
  entryCommand: 'secrets',
  /** 场景标题（调试与日志用；标题栏由场景自绘）。 */
  title: 'Secrets',
}

/**
 * 插件入口。声明式注册两个接缝，全部经 ctx.inject，清理挂在 apply 的 fiber 上。
 * @param {any} ctx - cordis 上下文。
 * @param {Partial<typeof DEFAULTS>} [config] - 来自 cordis.patch.yml。
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }

  // 已配置的引用名清单（只存名字）。值是 dsh-credentials 管的，我们永不读。
  const store = {
    loadNames: () => loadNames(),
    addName: (n) => addName(n),
    removeName: (n) => removeName(n),
  }

  const logger = {
    // 只记名字与结果，绝不记值；错误只记 code/name（错误文本可能带值）。
    info: (message) => ctx.logger?.info?.(`[dsh-tui-secret] ${message}`),
    warn: (message) => ctx.logger?.warn?.(`[dsh-tui-secret] ${message}`),
  }

  // 取值而不是记忆：credentials 是别的插件提供的服务，可能在 apply 之后才挂上。
  const getCredentials = () => ctx.get('credentials', false) ?? ctx.credentials

  const scene = makeScene({ getCredentials, store, logger })

  ctx.inject(['tuiScenes'], (sceneCtx) => {
    const dispose = sceneCtx.tuiScenes.register(
      { id: SCENE_ID, title: options.title, component: scene },
      ctx, // identity：效果台账的 pluginId；省略会被记为 undeclared（C-060）
    )
    ctx.effect(() => () => dispose())
    logger.info(`scene ${SCENE_ID} registered`)
  })

  ctx.inject(['commands'], (commandCtx) => {
    const definition = {
      name: options.entryCommand,
      description: '录入 / 查看 / 删除密钥（值不回显、不进会话）',
      handler: () => {
        const scenes = ctx.get('tuiScenes', false)
        if (!scenes?.open) {
          return { kind: 'error', text: 'dsh-tui 未提供场景面（tuiScenes），无法打开 /secrets' }
        }
        const opened = scenes.open(SCENE_ID)
        return opened
          ? { kind: 'success' }
          : { kind: 'error', text: 'secrets 场景未注册（插件可能被禁用）' }
      },
    }
    // 首选托管面（C-041）：命令被打上本插件的 verified 归属印，宿主的 invoke 检查点
    // 才能对 owner 生效（denies 掉本插件的 commands.invoke 就关掉这个入口）。托管面
    // 不在（旧 patch / 未通过准入）时退回直接注册：同进程信任边界 C-070 明确允许，
    // 只是没有归属。两条路都返回同一形状的 disposer。
    let dispose
    const host = ctx.get('tuiPluginHost', false)
    if (host?.registerCommand) {
      try {
        dispose = host.registerCommand(ctx, definition)
        logger.info(`command ${options.entryCommand} registered (attributed)`)
      } catch (error) {
        logger.warn(`attributed registration failed (${error?.code || error?.name || 'unknown'}), falling back`)
      }
    }
    if (!dispose) {
      dispose = commandCtx.commands.register(definition)
      logger.info(`command ${options.entryCommand} registered (unattributed)`)
    }
    ctx.effect(() => () => dispose())
  })
}

/**
 * 场景组件工厂。拆出来是为了能在没有 TUI 的环境里单测（scripts/verify.mjs）。
 * React 由场景 props 注入（宿主 React 硬契约），这里不 import 任何 React。
 */
function makeScene({ getCredentials, store, logger }) {
  const MASK = '\u2022\u2022\u2022\u2022' // 固定长度占位，连真实长度都不透露

  return function SecretsScene(props) {
    const { React, ui, close } = props
    const h = React.createElement
    const { Box, Text, useInput } = ui
    const [rows, setRows] = React.useState([])
    const [mode, setMode] = React.useState('list')
    const [cursor, setCursor] = React.useState(0)
    const [nameBuf, setNameBuf] = React.useState('')
    const [notice, setNotice] = React.useState('')
    const valueRef = React.useRef('') // 值不进 state：state 会被调试器与序列化看到
    // ref 改动本身不触发重绘，而掩码必须随输入刷新——用一个只当计数器的 state
    // 逼出重绘，counter 里装的永远是次数，不是值。
    const [, bumpPaint] = React.useState(0)
    const repaint = () => bumpPaint((n) => n + 1)

    const refresh = React.useCallback(() => {
      const credentials = getCredentials()
      const names = store.loadNames()
      setRows(names.map((n) => ({ name: n, state: '查询中' })))
      let cancelled = false
      void (async () => {
        const resolved = []
        for (const n of names) {
          if (!credentials) { resolved.push({ name: n, state: '服务不可用' }); continue }
          try {
            const info = await credentials.describe(n)
            const bits = [info?.configured ? '已配置' : '未配置']
            if (info?.source) bits.push(String(info.source))
            if (info?.writable === false) bits.push('只读')
            resolved.push({ name: n, state: bits.join(' · ') })
          } catch (error) {
            resolved.push({ name: n, state: `查询失败（${error?.code || error?.name || 'unknown'}）` })
          }
        }
        if (!cancelled) setRows(resolved)
      })()
      return () => { cancelled = true }
    }, [])

    React.useEffect(() => {
      if (mode !== 'list') return undefined
      return refresh()
    }, [mode])

    React.useEffect(() => () => { valueRef.current = '' }, [])

    // 回列表：只清值与模式；提示由调用方按需自己设（顺序反了会把刚写的提示清掉）
    const back = () => { valueRef.current = ''; setMode('list') }

    useInput((input, key) => {
      const credentials = getCredentials()
      if (mode === 'list') {
        if (key?.escape || input === 'q') { close(); return }
        if (key?.upArrow) { setCursor((c) => Math.max(0, c - 1)); return }
        if (key?.downArrow) { setCursor((c) => Math.min(Math.max(0, rows.length - 1), c + 1)); return }
        if (input === 'a') { setNameBuf(''); setNotice(''); setMode('name'); return }
        if (input === 'd' && rows[cursor]) { setNotice(''); setMode('confirm'); return }
        return
      }
      if (mode === 'name') {
        if (key?.escape) { back(); return }
        if (key?.return) {
          const problem = describeNameProblem(initialiseName(nameBuf))
          if (problem) { setNotice(problem); return }
          valueRef.current = ''
          setMode('value')
          return
        }
        if (key?.backspace) { setNameBuf((n) => n.slice(0, -1)); return }
        if (input && !key?.ctrl && !key?.meta) { setNameBuf((n) => (n + input).slice(0, 64)); return }
        return
      }
      if (mode === 'value') {
        if (key?.escape) { back(); return }
        if (key?.return) {
          const secretName = initialiseName(nameBuf)
          if (!credentials) { setNotice('credentials 服务不可用，未写入'); back(); return }
          if (valueRef.current.length === 0) { setNotice('值为空，未写入（空值等于未配置）'); back(); return }
          const payload = valueRef.current
          valueRef.current = '' // 提交前先在本地丢掉，失败也不留
          setMode('list')
          void Promise.resolve()
            .then(() => credentials.set(secretName, payload))
            .then(() => {
              store.addName(secretName)
              logger.info(`set ${secretName}`)
              setNotice(`已写入 ${secretName}（值不保留、不显示）`)
              refresh()
            })
            .catch((error) => {
              logger.warn(`set ${secretName} failed: ${error?.code || error?.name || 'unknown'}`)
              setNotice(`写入失败（${error?.code || error?.name || 'unknown'}）`)
            })
          return
        }
        if (key?.backspace) { valueRef.current = valueRef.current.slice(0, -1); repaint(); return }
        if (input && !key?.ctrl && !key?.meta) { valueRef.current += input; repaint(); return }
        return
      }
      if (mode === 'confirm') {
        const row = rows[cursor]
        if (key?.escape || input === 'n') { back(); return }
        if (input === 'y' && row) {
          if (!credentials) { setNotice('credentials 服务不可用，未删除'); back(); return }
          const secretName = row.name
          setMode('list')
          void Promise.resolve()
            .then(() => credentials.unset(secretName))
            .then(() => {
              store.removeName(secretName)
              logger.info(`unset ${secretName}`)
              setNotice(`已删除 ${secretName}`)
              refresh()
            })
            .catch((error) => {
              logger.warn(`unset ${secretName} failed: ${error?.code || error?.name || 'unknown'}`)
              setNotice(`删除失败（${error?.code || error?.name || 'unknown'}）`)
            })
        }
      }
    })

    const title = mode === 'list' ? '密钥（/secrets）'
      : mode === 'name' ? '新建 · 第 1 步：名字'
        : mode === 'value' ? `新建 · 第 2 步：值（${initialiseName(nameBuf)}）`
          : `确认删除 ${rows[cursor]?.name ?? ''}？`

    const body = []
    if (mode === 'list') {
      body.push(h(Text, { key: 'hint', dimColor: true }, 'a 新建 · d 删除 · ↑/↓ 选择 · Esc 关闭'))
      if (rows.length === 0) body.push(h(Text, { key: 'empty' }, '还没有录入过引用。按 a 开始。'))
      rows.forEach((row, index) => {
        body.push(h(Text, { key: row.name, ...(index === cursor ? { inverse: true } : {}) },
          `${index === cursor ? '>' : ' '} ${row.name}  ${row.state}`))
      })
    } else if (mode === 'name') {
      body.push(h(Text, { key: 'name' }, `名字：${nameBuf || '（大写字母 / 数字 / 下划线）'}`))
      body.push(h(Text, { key: 'key', dimColor: true }, 'Enter 下一步 · Esc 返回'))
    } else if (mode === 'value') {
      body.push(h(Text, { key: 'value' }, `值：${valueRef.current.length > 0 ? MASK : '（等待输入）'}`))
      body.push(h(Text, { key: 'key', dimColor: true }, '掩码显示 · Enter 写入 · Esc 放弃'))
    } else {
      body.push(h(Text, { key: 'warn' }, '这会从 dsh 凭据存储里删掉这个名字。y 确认 · n/Esc 取消'))
    }
    if (notice) body.push(h(Text, { key: 'notice', color: 'yellow' }, notice))

    return h(Box, { flexDirection: 'column', paddingX: 1, borderStyle: 'round' },
      h(Text, { key: 'title', bold: true }, title),
      h(Text, { key: 'disc', dimColor: true }, '值只经 ctx.credentials 写入：不回显、不记日志、不进会话。'),
      ...body)
  }
}

/** 供测试使用：与 apply 相同构造，但不依赖 cordis。 */
export const __internals = { makeScene, SCENE_ID, DEFAULTS }
