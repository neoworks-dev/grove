# Grove

Grove is a code editor built around embedded Neovim, Git worktrees, and AI coding
agents. It lets you work across multiple worktrees, run per-worktree dev services,
inspect logs, preview your work, and review changes without leaving the editor.

Everything happens in a graphical UI; terminals are there when you want one, not a
requirement.

## Features

- **Worktrees** — list, create (from a base branch, optionally a new branch), remove,
  with per-worktree dirty status and current branch. All operations shell out to the
  Git CLI (via `simple-git`); no custom Git behavior.
- **Config** — a YAML file (`grove.config.yaml`) at the repo root defines setup commands,
  named services, per-service commands / logs / preview URLs / health checks, and
  deterministic port allocation.
- **Service supervisor** — start/stop/restart services per worktree, capture output to
  `<worktree>/.workbench/logs/<service>.log` (purged on relaunch), track PIDs, poll
  health URLs, open preview URLs.
- **Editor** — embedded Neovim with a file tree, buffer tabs, and native Vim editing.
- **Diff viewer** — an integrated review workflow whose changed-file list and diff
  content come from `git diff` (staged/unstaged), never from client-side diffing.
- **Agents** — coding agents run per worktree on pluggable runtimes (Claude Code, Codex,
  pi, or Grove's own mode on top of one of them), with a model picked per session.
  Agents get Grove's own tools: file editing, search, LSP, shell, a per-worktree chat
  channel shared with the user and other agents, notes, spawning sub-agents in the same
  or a new worktree, and a review protocol that holds their writes for per-hunk approval.
  The Agents overview in the sidebar shows every worktree's sessions and which need you.
- **Git** — history graph, branches / tags / stashes, hunk-level staging, commit
  actions (cherry-pick, revert, reset), conflict resolution, and local-only checkpoints.
- **GitHub** — issues and pull requests via the `gh` CLI: comment, label, review, merge,
  and check out a PR into its own worktree.
- **Terminals** — integrated terminals run by a detached daemon, so shells survive
  reloads.
- **Language servers & search** — LSP per worktree (installable from the editor catalog)
  and ripgrep-backed content search.

## Environment variables per worktree

Exposed to setup and service commands, and to `${VAR}` substitution in preview/health URLs:

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

- `src/main/` — privileged backend: `git`, `config`, `ports`, `env`, `worktrees`,
  `services`, `state`, `nvim`, `lsp`, `terminals`, `github`, `review`, `checkpoints`, …
  - `src/main/agents/` — agent sessions, the harness registry and its adapters
    (`switchboard/`), and the tools Grove gives agents (`tools/`).
  - `src/main/kernel/` — the main-process root context and the service contracts routes inject.
  - `src/main/routes/` — the IPC surface, one plugin per domain.
- `src/preload/` — typed `window.workbench` bridge (context isolation on).
- `src/renderer/` — Svelte 5 UI.
  - `src/renderer/src/kernel/` — the surfaces that host everything else (`sidebar`,
    `editor`, `panel`; see `services/` and `coreServices.ts`).
  - `src/renderer/src/kernel/plugins/` — the core features that contribute into them.
  - `src/renderer/src/plugins/` — the sandboxed third-party plugin host: one Web Worker per
    plugin, one fiber per record, permissions brokered in main.
- `src/shared/` — types that cross IPC (`types.ts`, `agents.ts`, `plugins.ts`, …).
- `sdk/` — the plugin SDK; `sdk/src/protocol.ts` is the source of truth for the plugin protocol.

## Project setup

```bash
bun install          # also fetches the bundled Neovim
bun run dev          # build plugins, fetch Neovim, start electron-vite dev
bun test             # unit tests
bun run build        # typecheck, build plugins, bundle
bun run build:linux  # package (also build:mac, build:win, build:unpack)
```

## Contributing

Before opening a pull request, make sure these pass:

```bash
bun run lint
bun run typecheck
bun test
bun run test:e2e # Playwright end-to-end tests
```

Architecture and code-style guidelines are in [`AGENTS.md`](AGENTS.md).
