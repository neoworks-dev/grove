# Grove — agent guide

Grove is a git worktree editor: an Electron app that embeds Neovim as its only text editor and runs coding agents (Claude, Codex, OpenCode) in parallel worktrees. Svelte 5 renderer, TypeScript everywhere, bun for tests.

## Commands

- `bun test` — run the test suite in `tests/` (fast, no build needed)
- `npm run typecheck` — tsc for main/preload + svelte-check for renderer
- `npm run lint` — eslint
- Do **not** launch the app (`npm run dev`) to verify changes. The user runs the app himself; ask him for traces or confirmation instead of inspecting the UI yourself.

## Layout

| Path | What lives there |
| --- | --- |
| `src/main/` | Electron main process: git, worktrees, nvim RPC, terminals, agents, plugin host |
| `src/main/plugins/` | Plugin loader, permission broker, main-side RPC router |
| `src/preload/` | Context bridge (`window.workbench`) |
| `src/renderer/src/` | Svelte 5 UI: `components/`, `lib/` (stores, nvim canvas), `plugins/` (sandbox host) |
| `src/shared/` | Types shared between main and renderer |
| `sdk/` | `@grove/plugin-sdk` workspace — the public plugin API |
| `resources/plugins/` | Built-in plugins (manifest + source), built by `scripts/build-plugins.ts` |
| `tests/` | Bun tests, roughly one file per module |

## Plugin SDK — how to extend the API surface

The SDK's purpose is to let third-party plugins reach editor features cleanly. When adding capability, prefer extending the SDK over one-off internal hooks.

Architecture: plugins run in a sandboxed worker and only ever see the typed facade in `sdk/src/api.ts`, implemented by the host-injected runtime (`globalThis.__grove`). Plugin bundles contain no protocol logic.

Call chain for any API:

```
plugin code
  → sdk/src/index.ts                        (namespace shim)
  → src/renderer/src/plugins/sandbox/sdk-impl.ts   (worker-side RPC facade)
  → src/renderer/src/plugins/rpc.ts         (postMessage envelope)
  → src/renderer/src/plugins/host.svelte.ts (renderer handler; UI APIs end here)
  → src/main/plugins/router.ts              (main-process dispatch)
  → src/main/plugins/broker.ts              (permission gate: ensure / ensurePath)
  → implementation (git, files, search, …)
```

Checklist for a new API namespace or method — touch every layer, in this order:

1. `sdk/src/api.ts` — add the typed interface. This is the public contract; design it here first.
2. `sdk/src/protocol.ts` — add wire types; add a `PluginPermission` entry if the capability needs gating. This file is **additive-only**: breaking changes require a major bump of `GROVE_API_VERSION`.
3. `src/renderer/src/plugins/sandbox/sdk-impl.ts` — worker-side implementation that sends the RPC.
4. `src/renderer/src/plugins/host.svelte.ts` — handle it in `registerUiMethods()` (renderer-local) or `registerMainForwarding()` (needs main process).
5. `src/main/plugins/router.ts` — add the `invoke()` case if it reaches main; call `broker.ensure()` / `ensurePath()` before anything privileged.
6. `tests/pluginRpc.test.ts` / `tests/pluginManifest.test.ts` — round-trip test; manifest test if you added a contribution type.
7. If useful, exercise it in a built-in plugin under `resources/plugins/` (e.g. `grove.file-finder`).

Design rules for new APIs:

- Every capability is permission-gated (`workspace.read`, `ai.prompt`, …). Never expose a privileged operation without a broker check. `shell` and `net` are reserved and denied.
- Contributions (commands, keybindings, overlays, sidebars) are data-only in the manifest so they register before the worker starts; behavior binds later via `setHandler`.
- Use VS Code's extension API as inspiration for coverage and ergonomics, but keep Grove idioms: `Disposable`, `context.subscriptions`, camelCase, promise-based, no VS Code type imports.
- Plugin roots: built-in (`resources/plugins/`), user (`<userData>/plugins/`), project (`<repo>/.workbench/plugins/`). Project plugins require one-time trust per `id@version`.

## Conventions

- Svelte 5 runes only (`$props`, `$state`, `$effect`); typed props interface inline in the component.
- Semantic Tailwind tokens from the shared theme (`bg-elevated`, `text-dim`, `border-line`) — no raw palette colors. Reuse components from `@neoworks-dev/ui` before building new ones.
- Main-process modules are plain function exports, not classes; persisted state goes through `getRepoState` / `updateRepoState` in `src/main/state.ts`.
- File-header comment states the module's purpose; inline comments explain *why*, never *what*.
- Nvim is the sole editor. Never run the bundled nvim outside its XDG sandbox — it would touch the user's real `~/.local/share/nvim`.
- Fix root causes, not symptoms: don't swallow errors; diagnose and self-heal.

See `CLAUDE.md` for git workflow and detailed code-style rules; they apply to all agents.
