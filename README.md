<p align="center">
  <strong>English</strong> | <a href="README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-4b6fff?style=flat-square">
  <img alt="dsh-TUI plugin" src="https://img.shields.io/badge/dsh--TUI-plugin-7da1de?style=flat-square">
</p>

# dsh-tui-secret

> Secure secret entry for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI): `/secrets`
> opens a full-screen scene with **masked input → reference list → delete confirmation**.
> Values only ever reach DSH's own credential seam; the plugin never echoes one, never
> logs one, and never puts one into the conversation.
>
> The same code also ships a `dsh-tui-secret` CLI for scripts and non-TTY use. It does not
> bypass DSH storage: it shares the credential provider's writer lock and atomic-write
> protocol.

## Install

```bash
dsh plugin --profile dsh-tui add dsh-tui-secret
```

Or add one row to the profile's `cordis.patch.yml` (this package's own
`cordis.patch.yml` is exactly that row, applied by the bundle mechanism on install):

```yaml
- insert:
    - id: dsh-tui-secret
      name: dsh-tui-secret
      config:
        entryCommand: secrets   # any other command name works too
```

Restart the TUI and type `/secrets`.

## Scene usage

| Key | Action |
| --- | --- |
| `a` | New reference: name first, then value |
| `d` | Delete the selected reference (`y` confirms) |
| `↑` `↓` | Move the selection |
| `Enter` | Next step / write |
| `Esc` | Back one step; on the list, `Esc` (or `q`) closes the scene |

Names follow DSH rules: start with an uppercase letter, `A-Z 0-9 _` only, at most 64
characters. `DEEPSEEK_` / `DSH_` prefixes belong to the host — the plugin refuses them on
the spot with a readable reason, instead of letting dsh-TUI's `credentialRefGuard`
silently drop the ref later.

## CLI

```bash
dsh-tui-secret list [--json]                 # names and state only, never values
dsh-tui-secret set NAME --from-stdin         # read the value from stdin
dsh-tui-secret set NAME --from-file ./k.txt  # read the value from a file
dsh-tui-secret set NAME                      # on a TTY: one no-echo prompt
dsh-tui-secret rm NAME --yes                 # delete (refused without --yes)
```

A value never enters argv. Input is taken verbatim, with no trimming (`echo` appends a
newline — use `printf '%s'`); the command reports the byte count so it can be checked.

How it coexists with the scene:

- **Same lock**: exclusive `wx` create of `<credentials file>.lock`, giving up after two
  seconds with an error rather than guessing whether a holder still exists. It is the
  provider's own lock (derived from the same path).
- **Same atomic write**: random-suffix sibling in the same directory plus `rename`,
  mode 0600, directory 0700.
- **Re-read inside the lock**: the file is read again once the lock is held, so a commit
  by another writer is never overwritten.
- **Row-level upsert**: only the rows belonging to the target key are rewritten — other
  keys, comments, key order and block scalars (the provider writes `KEY: |` for values
  containing newlines) are left alone.
- **Fail-closed**: no `--from-stdin`/`--from-file` on a non-TTY, an empty value, an
  invalid name, a `DEEPSEEK_`/`DSH_` prefix, a name shadowed by the current environment
  (the write would be masked into an apparent success), or a credentials file wider than
  0600 — all exit with code 2 and write nothing. A file containing nested mappings or
  duplicate keys is likewise refused.
- Exit codes: `0` success, `1` runtime failure, `2` refusal or usage error.

The provider watches the file by default (`watch: true`) and reloads on external changes;
a deployment that turns the watcher off sees a new value on its next read.

`list` reads the keys of the credential document directly (the source of truth for
"what is stored") and merges in names recorded by the scene but not present there. The
scene lists its own name index and never reads the credential document — the provider
need not be file-backed, and the plugin should not assume where it lives.

## How a value stays out of sight

- **Values only go through `ctx.credentials.set(ref, value)`**: no second file, no writes
  to `.credentials.yaml` itself, no copies. An empty value is refused (in DSH semantics
  an empty value means unconfigured).
- **No value in React state**: it lives in a `useRef` and is dropped locally before the
  write, so a failure leaves nothing behind in state.
- **The mask is a fixed-length placeholder (`••••`)**: it neither echoes characters nor
  reveals the length — a per-character dot mask already leaks information.
- **No shellEnv contributor is registered**: `$NAME` never appears in the environment the
  model can execute in, and it never competes with the `DSH_SECRET_*` key space of another
  plugin.
- **No tools, no `ctx.on('tools/execute' | 'llm/stream')`**: the model side has no exit, so
  a value cannot reach tool-result, tool-card or llm-stream.
- **Logs and errors carry the name and an error `code` only**: raw error text may embed
  the value, so it is never printed or persisted.
- **The list shows configured state, source and writability only**, straight from
  `credentials.describe()`, which is designed not to return a value.

These statements are not source-reading claims: `npm test` actually drives the scene
frame by frame — see Verification.

## Storage

| Content | Location | Mode |
| --- | --- | --- |
| Values (owned by DSH) | `<DSH_HOME>/.credentials.yaml` | 0600, guaranteed by the provider |
| Reference-name index (this plugin) | `$DSH_TUI_HOME/dsh-tui-secret/refs.json` (default `~/.dsh-tui/…`) | file 0600, directory 0700, atomic write |

Why the name index exists: `ctx.credentials` exposes only
`resolve / describe / set / unset` — there is **no list()**, so recorded names cannot be
recovered from it. `refs.json` holds names only; it is an index of references, not a
secret store, and a damaged file reads as empty rather than being overwritten.

The ecosystem's proper home for private plugin data is `storage.local` behind
`ctx.get('tuiPluginStorage', false)` (stored under
`~/.dsh-tui/plugin-storage/<namespace>.json`), but its `storage.local.read/write`
permissions are denied by default and require an entry in
`~/.dsh-tui/extension-grants.json`. v1 chooses zero authorization and therefore writes to
the plugin-private directory above.

## Boundaries

- **The CLI is not a second store**: it writes the provider's file and takes the
  provider's lock. It lacks the provider's semantic completeness — the provider refuses a
  write shadowed by *its own* launch environment, while the CLI can only judge by its own
  process environment, so the verdicts can differ when a session starts from another
  shell.
- **No shell injection**: v1 only writes the credential store, for plugins that consume
  credentials by ref (LLM keys and the like). Making `$NAME` visible in the model's shell
  requires an additional shellEnv contributor and a prefix that cannot collide with
  another plugin's.
- **No system keyring** (keyring / DPAPI): storage follows DSH's own semantics.
- **No upstream patch**: dsh-TUI already declares the `secret: { ref }` field for settings
  sections; once its settings screen renders a mask of its own, this scene can shrink to
  list management.

## Verification

```bash
npm test        # = node scripts/verify.mjs
```

The script covers both halves plus one gate: `①–⑫` the scene (sentinel checks), `⑬–⑲` the
CLI (write protocol and fail-closed behaviour), and `⑳` the plugin declaration, run through
the host's own `@dsh-std/manifest` parser and the TUI profile validator.

- **The scene half** builds a minimal React hook runtime and a ui kit stand-in, drives the
  scene with real key order (`a` → name → `Enter` → value → `Enter`), records every
  rendered frame, every log line and every outbound call, then greps for a sentinel value.
  Step `⑫` swaps in the host's own React 19 and ink and renders into a non-TTY stream,
  frame by frame — element symbols, hook dispatcher and render path are all real.
- **The CLI half** runs the real entry point as a subprocess and cross-checks with the host
  `yaml` package (parsing the file back to compare the value) and with the provider's real
  `withFileLock` (holding the lock against the CLI).

`21/21 PASS` today:

```
PASS  ① an empty value is refused: Enter writes nothing
PASS  ② a reserved prefix is refused: DSH_ names are not accepted
PASS  ③ per-keystroke masking: only a fixed mask on screen, no value and no length
PASS  ④ the value reaches credentials.set only: zero hits in frames and logs
PASS  ⑤ a short value (2 characters) also stays off screen
PASS  ⑥ deletion needs an explicit y; any other key deletes nothing
PASS  ⑥b with credentials missing, deletion is not reported as done
PASS  ⑦ Esc closes the scene
PASS  ⑧ a failed write reports the error code only, never the value or raw error text
PASS  ⑨ apply touches two seams only and mounts no model-facing hook
PASS  ⑩ the name index holds names only; file 0600, directory 0700
PASS  ⑪ a damaged name index is neither overwritten nor fatal
PASS  ⑫ real host render (real React + real ink): the mask repaints and no value lands on screen
PASS  ⑬ cli set: a row-level upsert — comments, other keys and block scalars survive
PASS  ⑭ cli set over an existing key: only that row changes, every other byte stays
PASS  ⑮ cli and provider share one lock: a held lock means an error exit and no write
PASS  ⑯ cli fail-closed: no source / empty value / reserved prefix / shadowed / wide mode all refuse and write nothing
PASS  ⑰ cli rm: refused without --yes; with it, only that key goes
PASS  ⑱ cli list: names and state only, no value anywhere in the output
PASS  ⑲ cli set --dry-run: no write, no lock
PASS  ⑳ the declaration passes the upstream parser and the TUI profile gate
```

`⑫` needs a dsh-TUI profile on the machine and `SKIP`s without one (`DSH_TUI_PROFILE=`
points elsewhere); the two cross-checks in `⑬` and `⑮` likewise `SKIP` when the host
`yaml` package or the provider's lock implementation is unavailable. A `SKIP` is not a
failure.

What it does **not** prove: a real terminal's scrollback and session recording, and
writers outside the terminal (the web card, or `dsh` writing the same credential document).
Those need a real terminal; the script does not stand in for manual testing.

## Compatibility

- Only **`@deepseek-harness-tui/dsh-tui`** (read against 0.16.x; other TUI implementations
  are out of scope).
- Node `^22.19 || >=24`; ESM; no runtime dependencies; `@deepseek-ai/cordis` is an
  optional peer.
- Seams: `ctx.tuiScenes` (full-screen scene), `ctx.commands` (command), `ctx.credentials`
  (the DSH core credential service). A missing scene seam degrades silently into "nothing
  happens" and never breaks TUI startup.

## Open contract questions

1. **`Config` is not exported.** The plugin guide names three faces — `name`, `Config`,
   `apply` — but this package's only config key, `entryCommand`, falls back via
   `?? DEFAULTS` inside `apply`, with no Schemastery `Config` export. If profile manifest
   validation requires one, adding a `@deepseek-ai/schemastery`
   `Schema.object({...}).default(...)` is enough.
2. **Command registration path.** The command defaults to the plugin-host mediated surface
   `ctx.tuiPluginHost.registerCommand(ctx, definition)`, which stamps it with this plugin's
   verified identity so the host's `commands.invoke` denies apply to it; when that surface
   is missing or the registration is refused, it falls back to a direct
   `ctx.commands.register` (same-process trust boundary). The declared contribution id in
   `dsh-plugin.json` is `dsh-tui-secret.open`, which need not match the registered command
   name `secrets` — a contribution id is a declaration identity, not a command name.

Design notes: [docs/plugin-design.md](docs/plugin-design.md).

## License

[MIT](LICENSE)
