# Worktree Workbench

A model-agnostic AI coding cockpit. A graphical desktop app to manage multiple Git
worktrees at once, run per-worktree dev services on deterministic ports, preview them,
inspect logs, edit code in a GUI editor with Vim bindings, review changes in a
side-by-side diff, and launch replaceable CLI agents (`claude -p`, `codex exec`, …).

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
- **Editor** — Monaco with a file tree, tabs, Vim keybindings (`monaco-vim`), and save.
- **Diff viewer** — side-by-side Monaco DiffEditor; changed-file list and diff content
  are sourced from `git diff` (staged/unstaged), never diffed in JS.
- **Agents** — named command adapters launched per worktree via exec-capture; output
  (e.g. `claude -p` JSON) streams into the Agent pane and a log file. Multiple worktrees
  can run agents concurrently.
- **Dashboard** — overview across all worktrees: ports, service status, active agents.

## Environment variables per worktree

Exposed to service and agent commands, and to `${VAR}` substitution in preview/health URLs:

```
WT_ID  WT_NAME  WT_PATH  WT_BRANCH  PORT_0  PORT_1  ...
```

Port block for a worktree = `ports.start + slot * ports.count_per_worktree`, where the
slot is stable and persisted.

## Architecture

- `src/main/` — privileged backend (pure, unit-testable TS): `git`, `config`, `ports`,
  `env`, `worktrees`, `services`, `agents`, `state`, `ipc`.
- `src/preload/` — typed `window.workbench` bridge (context isolation on).
- `src/renderer/` — Svelte 5 UI: sidebar, editor, diff, services, logs, preview, agent,
  dashboard.
- `src/shared/types.ts` — shared type definitions.

## Project Setup

```bash
bun install      # or npm install
bun run dev      # electron-vite dev
bun test         # unit tests for the pure main modules
bun run build    # typecheck + bundle
```
