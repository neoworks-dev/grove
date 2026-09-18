---
name: grove-plugins
description: How Grove is wired onto @neoworks/extension-system — the two registration rules, where every plugin, service, route, sidebar view and agent harness lives, and the $state-on-Service trap. Use before adding or editing a plugin, service, IPC route, sidebar view or harness in this repo.
---

# Grove on the extension system

Grove runs on `@neoworks/extension-system`. Core features and third-party plugins
are both plugins on one kernel. Read that package's own skill
(`skills/extension-system/SKILL.md`) for the kernel itself — fiber lifecycle,
dispatch modes, `isolate`/`intercept`. This skill is only what's specific to Grove.

## The two rules

**Register through `ctx.effect`.** Anything a plugin does to the outside world
hands back the inverse. Renderer registries (`ctx.commands.register`,
`ctx.panes.register`, …) already return a disposer, so wrapping them is a
one-liner. Raw APIs — `setInterval`, a DOM listener, a `Worker`, `ipcMain.handle`
— must return their own.

**Declare what you need through `inject`.** A plugin contributing to the sidebar
injects `'sidebar'` and only runs while it exists.

## Where things live

Renderer:

- `src/renderer/src/kernel/` — the root context, the registries published as
  services, the host services (`editor`, `panel`) and the core feature plugins.
  `kernel/plugins/` is where a feature lives, `kernel/services/` is what hosts it.
- `src/renderer/src/kernel/plugins/sidebar/` — the sidebar host: the service, the
  rail-launcher registry, `ActivityBar.svelte`. Each view it shows is a sibling
  plugin directory (`explorer/`, `worktrees/`, `gitChanges/`, `agents/`,
  `checkpoints/`, `extensions/`, `setup/`) holding its plugin and the components
  only it renders.
- `src/renderer/src/components/` — components shared across features. A component
  only one feature renders belongs in that feature's plugin directory instead.
- `src/renderer/src/lib/` — the non-visual half: stores (`*.svelte.ts`), keymap and
  binding resolution, and `lib/agents/` (transcript fold, session store, catalogs,
  tool rendering — the logic behind the agent pane).
- `src/renderer/src/plugins/` — the sandboxed third-party host, one Worker and one
  fiber per plugin record. Not to be confused with `kernel/plugins/`, which is
  Grove's own features.

Main:

- `src/main/kernel/` — the root context, the service contracts, route registration.
- `src/main/routes/` — the IPC surface, one file per domain (`git`, `agents`,
  `review`, …). Adding an IPC method means adding it here, not in `index.ts`.
- `src/main/agents/` — the agent runtime: `store.ts` (sessions + the append-only
  event log), `service.ts` (what the renderer drives), `reviewBridge.ts`,
  `tools.ts` (Grove's own tools), `roster.ts` + `handoffBridge.ts` (agents talking
  to each other). `harnesses/` holds one plugin per coding agent (`claude`,
  `codex`, `pi`), each registering a descriptor into the `harnesses` registry.
  Adding another means adding a file there and listing it in
  `src/main/routes/index.ts`.
- `src/main/api/` — the external API: socket, dispatcher, pairing, per-scope routes
  under `api/routes/` (including `debug.ts`, which only mounts under `GROVE_DEBUG=1`).
- Flat files at the root of `src/main` are the services themselves (`git.ts`,
  `nvimRpc.ts`, `lsp.ts`, `review.ts`, …) — routes stay thin and call into these.

## The `$state` trap

Do not put `$state` class fields on a `Service` subclass. Svelte compiles them into
private fields, and `isolate`/`intercept` re-create the service through
`Object.create()`, which then throws on the inherited accessor. Keep reactive state
in the `.svelte.ts` registry the service delegates to.
