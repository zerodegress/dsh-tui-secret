#!/usr/bin/env node
// 薄入口：真正的实现在 lib/types/cli.js（同一份代码的另一半，测试直接调它）。
import { main } from '../lib/types/cli.js'

process.exitCode = await main(process.argv.slice(2))
