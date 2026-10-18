// Remove the compiled output before a fresh `tsc` run.
//
// `tsc` never deletes the output of a file that no longer exists, so a stale `lib/` would
// otherwise ship (we hit exactly that when `src/cli.ts` went away). `compile` runs this first.
import fs from 'node:fs'

fs.rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true })
