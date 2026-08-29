# Grove

Grove is a code editor built around embedded Neovim, Git worktrees, and AI coding
agents. It lets you work across multiple worktrees, run per-worktree dev services,
inspect logs, preview your work, and review changes without leaving the editor.

Not a terminal-first app — terminals/exec are implementation details behind a graphical UI.

## Features

- **Worktrees** — list, create (from a base branch, optionally a new branch), remove,
  with per-worktree dirty status and current branch. All operations shell out to the
  Git CLI (via `simple-git`); no custom Git behavior.
- **Config** — a YAML file (`workbench.yaml`) at the repo root defines setup commands,
  named services, per-service commands / logs / preview URLs / health checks, agents,
  and deterministic port allocation.
- **Service supervisor** — start/stop/restart services per worktree, capture output to
  `<worktree>/.workbench/logs/<service>.log` (purged on relaunch), track PIDs, poll
  health URLs, open preview URLs.
- **Editor** — embedded Neovim with a file tree, buffer tabs, and native Vim editing.
- **Diff viewer** — an integrated review workflow whose changed-file list and diff
  content come from `git diff` (staged/unstaged), never from client-side diffing.
- **Agents** — named command adapters launched per worktree via exec-capture; output
  (e.g. `claude -p` JSON) streams into the Agent pane and a log file. Multiple worktrees
  can run agents concurrently.
- **Dashboard** — overview across all worktrees: ports, service status, agents.

## Environment variables per worktree

Exposed to service and agent commands, and to `${VAR}` substitution in preview/health URLs:

```
WT_ID  WT_NAME  WT_PATH  WT_BRANCH  PORT_0  PORT_1  ...
```

Port block for a worktree = `ports.start + slot * ports.count_per_worktree`, where the
slot is stable and persisted.

## Architecture

Grove is built on [`@neoworks/extension-system`](https://github.com/neoworks-dev/extension-system),
a plugin kernel with revertible effects and reactive dependency resolution. Core features and
third-party plugins use the same mechanism: a plugin registers everything through `ctx.effect`,
which carries the inverse, and declares what it needs through `inject`, so it only runs while
those services exist.

- `src/main/` — privileged backend (pure, unit-testable TS): `git`, `config`, `ports`,
  `env`, `worktrees`, `services`, `state`.
  - `src/main/kernel/` — the main-process root context and the service contracts routes inject.
  - `src/main/routes/` — the IPC surface, one plugin per domain.
- `src/preload/` — typed `window.workbench` bridge (context isolation on).
- `src/renderer/` — Svelte 5 UI.
  - `src/renderer/src/kernel/services/` — the surfaces that host everything else: `sidebar`,
    `editor`, `panel`.
  - `src/renderer/src/kernel/plugins/` — the core features that contribute into them.
  - `src/renderer/src/plugins/` — the sandboxed third-party plugin host: one Web Worker per
    plugin, one fiber per record, permissions brokered in main.
- `src/shared/types.ts` — shared type definitions.

## Project setup

```bash
bun install
bun run dev      # electron-vite dev
bun test         # unit tests for the pure main modules
bun run build    # typecheck + bundle
```
