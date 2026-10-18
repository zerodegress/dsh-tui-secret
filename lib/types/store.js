// 名字清单的落点：只存「用户录入过哪些引用名」，绝不存值。
//
// 位置在既有的 `~/.dsh-tui` 下（生态规范：用户数据只放既有位置），不碰
// `.credentials.yaml` 本体——值的写入永远只走 `ctx.credentials`。
// 这也意味着本模块不 import 任何 dsh 包，单独可测。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** dsh credentials 的引用名语法（与 api-settings-controller 的校验一致）。 */
export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * 宿主保留的引用前缀。dsh-tui 的 `credentialRefGuard` 在设置区块路径上会剔除
 * `DEEPSEEK_*` / `DSH_*`；我们在这里先自查一遍，给出可读的理由，而不是等宿主静默丢弃。
 */
export const RESERVED_PREFIXES = ['DEEPSEEK_', 'DSH_']

export function initialiseName(name) {
  return String(name ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
}

export function describeNameProblem(name) {
  if (!name) return '名字不能为空'
  if (!NAME_PATTERN.test(name)) return '名字只能是大写字母、数字与下划线，且以字母开头（≤64）'
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `以 ${RESERVED_PREFIXES.join(' / ')} 开头的名字归宿主所有，请换一个（例如 BILI_COOKIE）`
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

/** 读名字清单；文件缺失或损坏都返回空表——损坏时绝不覆盖原文件。 */
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

/** 原子写（同目录临时文件 + rename，0600），与 dsh 自己的写法一致。 */
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
