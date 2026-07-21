# Grove — agent guidelines

Electron + electron-vite, Svelte 5 (runes), TypeScript, Tailwind 4 + daisyUI,
bun for tests and scripts. Embedded nvim is the sole editor (no CodeMirror).

## Architecture

- Respect the process split: `src/main` (git, nvim RPC, agents, LSP),
  `src/preload`, `src/renderer`, `src/shared` (only types that cross IPC).
- Use adapter/registry patterns, never static lists. Discover options from
  CLIs/registries at runtime; type discovered things as open strings, not
  closed unions (a new provider must not require a code change here).
- Adapters (agent SDKs, plugins) never touch Electron/IPC directly — they get
  a context object with callbacks.
- State is push-fed into stores; never poll.
- Fix root causes, not symptoms. Don't swallow errors — diagnose and
  self-heal (e.g. restart a crashed nvim) instead of hiding the failure.

## Plugin SDK / public API design

- Everything crossing the worker boundary is async. No sync snapshots.
- Mutations use optimistic concurrency: caller passes the version it read,
  host rejects with `stale` instead of applying blind. Concurrent user +
  agent edits are the normal case, design for them.
- Expose stable Grove ids only. Never leak internals: nvim bufnrs/extmark
  ids, pty handles, LSP connections, simple-git objects.
- Keyed registrations have replace semantics (same key overwrites, dispose
  clears); no incremental add/remove APIs.
- Plugins get semantic style names (`info`/`warn`/`error`/`hint`), never raw
  colors or highlight groups.
- Split permissions by blast radius: read/observe cheap to grant,
  write/interact gated separately. Prefer coarse safe verbs the host already
  knows how to do over raw escape hatches (no arbitrary git/shell in v1).
- Anything a plugin/agent sends into shared channels gets its identity
  stamped by the host (`plugin:<id>`), never self-reported.
- Protocol changes are additive; breaking changes bump GROVE_API_VERSION
  major. Keep `sdk/src/protocol.ts` the single source of truth.

## Code style

- File-top block comment states the file's role and design rationale.
  Comments explain why and constraints ("replace semantics", "unspoofable"),
  never restate the code. Full sentences.
- Named exports only. Svelte components stay presentational; logic lives in
  `src/renderer/src/lib/*.svelte.ts` stores using runes.

## Nvim

- Bundled nvim runs only with the app's XDG isolation. Never launch it
  standalone — it would hit the user's real `~/.local/share/nvim`.

## Tests

- bun:test, flat `tests/` dir, one file per module.
- Hand-rolled fakes (e.g. a fake adapter that records calls) and temp dirs;
  no mocking frameworks.

## Workflow

- The user runs the app himself. Don't launch dev servers or write temp
  repro code — ask for traces/logs instead.
- No Co-Authored-By trailers in commits.
