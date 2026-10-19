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
> The agent can ask for one: `request_credential` puts a masked card in front of you and the
> value goes straight into the DSH credential store — the tool only gets a status back.
> `use_credential` then runs one command with that value in **its own child process**, and the
> returned output has every occurrence of the value replaced with `[credential]`.

## Highlights
- **Masked entry inside the scene** — `/secrets` opens a full-screen scene: `a` starts a
  reference, the value is typed with per-keystroke masking, `Enter` writes it.
- **A fixed-length mask** — `••••` whatever the length: the screen shows neither the
  characters nor how many there are.
- **The agent asks, you decide** — `request_credential(ref, purpose)` shows a card with the
  name, the purpose and four choices: not allowed / once / this session / until a time.
- **Stored, never handed over** — the value reaches `ctx.credentials` and nothing else; the
  tool's result carries a status, and the value never enters the conversation.
- **Use without handing it over** — `use_credential(ref, argv)` runs one command with the
  value in that child process only and replaces it with `[credential]` in the returned output.
- **List, delete and revoke, values never shown** — the list reports configured state plus the
  agent permission: `d` deletes (explicit `y`), `v` revokes one permission, `R` revokes all.
- **The declaration is gated** — `npm test` runs `dsh-plugin.json` through the host's own
  parser and the TUI profile validator, so a drifted manifest fails locally.


## Quick Start
Supported target: **`@deepseek-harness-tui/dsh-tui`** 0.16.x — other TUI implementations
are out of scope.

```sh
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

### Agent tools
Two tools are registered at runtime (the host has no manifest contract for tools):

| Tool | Arguments | Returns |
| --- | --- | --- |
| `request_credential` | `ref`, `purpose` | `stored` / `cancelled` / `refused` |
| `use_credential` | `ref`, `argv[]`, `timeoutMs?` | `exitCode`, `stdout`, `stderr`, `redacted`, `timedOut`, `aborted`, `injectedAs` |

`use_credential` runs exactly one command. The value goes into that child process's
environment under the name reported back as `injectedAs`; it never enters the shell you or the
agent sit in, and the executor's sandbox policy still applies. `argv` reaches the plugin as an
array and each element is quoted by the plugin, so the model cannot feed the shell raw text: to
use a pipe or a variable, it writes `["sh","-c","…"]` itself and that inner shell expands it.

The value is entered by **you**, on the card. Neither tool accepts a value from the model, and
neither tool ever returns one.

## Keybindings
| Key | Action |
| --- | --- |
| `a` | New reference: name first, then value |
| `d` | Delete the selected reference (`y` confirms) |
| `v` | Revoke the agent permission on the selected reference |
| `R` | Revoke every agent permission (`y` confirms; the stored values stay) |
| `↑` `↓` | Move the selection |
| `Enter` | Next step / write |
| `Esc` | Back one step; on the list, `Esc` (or `q`) closes the scene |

On a card the agent asked for: `1`–`4` (or `↑`/`↓`) pick the permission, `Enter` moves on,
`r` refuses, `Esc` cancels.

Names follow DSH rules: start with an uppercase letter, `A-Z 0-9 _` only, at most 64
characters. `DEEPSEEK_` / `DSH_` prefixes belong to the host — the plugin refuses them on
the spot with a readable reason, instead of letting dsh-TUI's `credentialRefGuard`
silently drop the ref later.

## How It Works
- **Values only go through `ctx.credentials.set(ref, value)`**: no second file, no writes
  to `.credentials.yaml` itself, no copies. An empty value is refused (in DSH semantics
  an empty value means unconfigured).
- **No value in React state**: it lives in a `useRef` and is dropped locally before the
  write, so a failure leaves nothing behind in state.
- **The mask is a fixed-length placeholder (`••••`)**: it neither echoes characters nor
  reveals the length — a per-character dot mask already leaks information.
- **No shellEnv contributor is registered**: `$NAME` never enters the environment the model
  executes in. The only environment that ever holds the value is the one child process
  `use_credential` spawns.
- **The two tools are the whole model-facing surface** (nothing else is registered on
  `tools/execute` or `llm/stream`): `request_credential` answers with a status, `use_credential`
  with exit code and redacted output.
- **Logs and errors carry the name and an error `code` only**: raw error text may embed
  the value, so it is never printed or persisted.
- **The list shows configured state, source and writability only**, straight from
  `credentials.describe()`, which is designed not to return a value.

These statements are not source-reading claims: `npm test` actually drives the scene
frame by frame — see Development.

- **Seams** — `ctx.tuiScenes` (full-screen scene), `ctx.commands` (command) and
  `ctx.credentials` (the DSH core credential service). A missing scene seam degrades
  silently into "nothing happens" and never breaks TUI startup.
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

## Known Limitations
- **The credential store is plain text**: DSH stores values in
  `<DSH_HOME>/.credentials.yaml` (no encryption), mode 0600 — that only keeps other local
  users out, and the sandbox limits writes, not reads. An agent with `bash` can therefore
  `cat` it. Blocking that needs an OS-level read restriction or moving the value out of the
  user's reach: host or operations work, not this plugin's.
- **Redaction covers one execution's returned slice**: the value cannot appear in a tool
  result we produce, but a command may write it to a file, a network request or a log and fetch
  it back; a truncated or transformed copy is not recognised either. `redacted: false` means
  "nothing was detected in what came back", not "the output never held it".
- **The permission gate is ours, not the store's**: another plugin that calls
  `credentials.resolve(ref)` with the same name reads the value directly — we do not pretend
  otherwise. The guarantee is narrower and true: every path the **agent** takes goes through
  these two tools.
- **A short value can make output unreadable**: redaction replaces **every** occurrence (the safe
  choice — replacing only the first would leak the rest) and the scene accepts two-character values,
  so a short one rewrites every matching substring in a command's output. The replacement is a single
  pass, so a value that happens to be `credential` does not get substituted twice. The card carries a
  standing note about this (made conditional, it would leak the value's length).
- **`session` permissions never expire on their own**: resuming a session creates a new agent
  with the same session id, so nothing can tell "this session is gone for good". Revoke them
  yourself (`v`, `R`), or delete the reference. Only `once` and `until` clear themselves.
- **No system keyring** (keyring / DPAPI): storage follows DSH's own semantics.
- **No upstream patch**: dsh-TUI already declares the `secret: { ref }` field for settings
  sections; once its settings screen renders a mask of its own, this scene can shrink to
  list management.

## Development
```sh
pnpm install    # first run: typescript / @types/node / @deepseek-ai/cordis (build only)
npm test        # = npm run compile && node scripts/verify.mjs
```

The source is TypeScript in `src/`; `tsc` compiles it into `lib/types/`, which is what the host
the host loads and what the npm package ships. `lib/` is generated and is not in git.

The script covers three layers plus one gate: `①–⑫` the scene (sentinel checks, including a
real ink render), `⑬–⑮` the quoting of the model's `argv` against a real `/bin/sh`, the tools
and the permission table (`㉑–㊵`: registration, refusals, scopes, audit, redaction's honest edges,
revoke, degradation, the card round-trip, the refusal reason codes, and both tool outputs against
their declared schemas through the host's own validator), and `⑳` the plugin declaration through
the host's own `@dsh-std/manifest` parser and the TUI profile validator.

**Troubleshooting**: the scene is registered on first use, not at startup, because dsh-TUI only
admits a `tuiScenes` call from an activation it has already recorded (`apply` and an `inject`
callback both run under a different ambient activation). When `/secrets` reports "the secrets
scene is not registered", the parenthesis carries a short reason code — `registration failed:
<code>` (the registration step threw; the same line is in the log, with the code/name only, never
the raw error text) or `open failed: <code>`. When a card always comes back `refused`, start the
TUI with `DSH_TUI_SECRET_DEBUG=1`: the note on `request_credential` then names the concrete reason
(`the host did not open the scene`, `the card was answered with refuse`, `the tool call was aborted`, …).
A reason never carries a value, and by default a human refusal and a card that cannot be shown stay
indistinguishable — so the failure reason cannot become a probe.

- **The scene half** builds a minimal React hook runtime and a ui kit stand-in, drives the
  scene with real key order (`a` → name → `Enter` → value → `Enter`), records every
  rendered frame, every log line and every outbound call, then greps for a sentinel value.
  Step `⑫` swaps in the host's own React 19 and ink and renders into a non-TTY stream,
  frame by frame — element symbols, hook dispatcher and render path are all real.
- **The tools** are driven through a fake host (the same way the scene is driven through a
  fake React), and the quoting checks run the built command through a real `/bin/sh`: hostile
  arguments must arrive as data, and only a script the model writes itself may expand.

Toolchain: Node `^22.19 || >=24`, ESM, no runtime dependencies;
`@deepseek-ai/cordis` is an optional peer. The three devDependencies are for the build and the
types only — a fresh clone needs `pnpm install` (network) before `npm test`.
Open contract questions are tracked in [docs/plugin-design.md](docs/plugin-design.md).

## Documentation
- **Design** — [plugin-design.md](docs/plugin-design.md) · [documentation index](docs/README.md)
  · [dsh-TUI plugin guide](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/tui-profile/docs/plugin-admission-and-development.md)
## License
[MIT](LICENSE)
