#!/usr/bin/env node
// Thin entry point: the implementation lives in lib/types/cli.js (the other half of the
// same code, which tests call directly).
import { main } from '../lib/types/cli.js'

process.exitCode = await main(process.argv.slice(2))
