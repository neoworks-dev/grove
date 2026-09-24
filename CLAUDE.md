## Git

Commit the worktree first if it's dirty, then write your changes. Short, to-the-point commit title; a body explaining the change when the title doesn't carry it; ask if you're unsure what to write. Always say the commit was made by you, not a human. On a feature branch, only commit what that branch is for.

No trailers, ever: no `Co-Authored-By` on a commit, no "Generated with Claude Code" on a PR.

## Writing

Commits, issues and pull requests carry only what matters. Say the thing, explain what a reader won't see for themselves, stop. No restating the diff, no summarising what you just said, no section that exists because the format seemed to want one.

## Issues and branches

Work lives in GitHub issues on `neoworks-dev/grove`, not in a file in the repo.

Write to GitHub as the bot: issues, comments, PRs and their edits, labels and `gh pr ready` go through `gh bot` (`gh bot issue comment 12 --body …`), so they show as `neoworks-bot[bot]`, not as me. Plain `gh` is for reading only. The bot as author already says a model wrote it, so no "written by Claude" line in the text. If `gh bot` fails, say so rather than falling back to plain `gh`. It lives in `~/Documents/neoworks/gh-bot`, and `bun run qa` uses it on its own.

Before starting on anything, check whether it is already half-built: `git branch -a` and `gh pr list` for the feature, and read what is on the branch. Sessions end mid-feature, and a branch is where that work is — starting again on `main` writes it a second time and loses whatever the first attempt learned. If a branch for it exists, continue on it.

Anything more than a tiny change: open an issue (`gh issue create`) with the labels below, branch off `main` as `<issue-number>-<slug>` (e.g. `12-tab-strip-overflow`), then open a draft PR towards `main` straight away.

A PR is a small batch: one issue, or a few that touch the same code. Anything found along the way gets its own issue and stays out of the PR, unless the PR can't finish without it. Branch off `main`; stack on another branch only when the code depends on it, and name the base in the body.

The PR body opens with its issues as a checklist, followed by the `Closes` lines:

```
- [ ] #23 code theme
- [ ] #24 indent guides

Closes #23
Closes #24
```

Straight to `main`, no issue and no branch: typos, one-liners, and anything that only touches how we work rather than the app — this file, `.claude/skills/`, editor config. Moving the extension-system rules into the `grove-plugins` skill was one of those.

No issue either when the work is still undefined — building out a surface we're feeling our way through, where the shape comes from what we find as we go. An issue describes a known outcome, and there isn't one yet; writing it up front would be a guess, and keeping it current would cost more than it tells anyone. Still branch, and still open a PR — just without a `Closes`.

The moment that exploration names something concrete, it gets an issue — and anything that won't finish in one session always does, however loosely defined it still is. A session ends and its context goes with it; an issue is the only thing that carries a goal across to the next one. Write them as soon as the list exists, not once the work starts.

Labels are two axes. Type is GitHub's default `bug` or `enhancement`. Area is exactly one of:

- `area:editor` — nvim surface: buffers, rendering, bundled config
- `area:agents` — agent runtime, chat pane, composer, review flow
- `area:panes` — layout, splits, dividers, pane chrome
- `area:sidebar` — the rail and its views
- `area:git` — git changes, worktrees, checkpoints
- `area:terminal` — terminal pane
- `area:plugins` — plugin host, extensions view, and the panes built as plugins (GitHub, dashboard)
- `area:ui` — app shell: top bar, menus, theming

Two areas is fine when an issue genuinely spans them; three means split it.

`ai-found` is not a third axis — the QA harness adds it to everything it files, so a model's findings can be told apart from a person's. Nothing else uses it.

## Done means verified

An issue is done when its fix has been shown to work, not when the code is written. Shown means one of:

- reproduced through `bun run qa` beforehand and shown fixed afterwards, with screenshots of both;
- a test under `tests/` that fails without the fix and passes with it.

`bun test` passes on the branch either way.

As soon as one issue is done, before starting the next:

1. Comment on the issue with `bun run qa evidence --issue <n> --body … --screenshot …`: what changed, in a sentence or two, plus the screenshots or the test's output.
2. Tick its box in the PR body and link that comment.
3. Merge the branch into `next` and push.

Once every box is ticked, `gh pr ready`. Don't leave a PR in draft with its work finished, and don't tick a box without evidence to show for it.

## `next`

`next` is what I run Grove from: it stays checked out in the repo root, so verified work shows up there straight away. Never switch branches in the root. Work happens in a worktree under `.worktrees/<branch>` (`git worktree add .worktrees/<branch> <branch>`), and merges into `next` are made in the root, where they land in my running app. When a merge touches `src/main` or `src/preload`, tell me to restart. It gets merges only — never commit on it directly, and never merge anything into it without evidence. If merging into `next` conflicts, resolve the conflict in the merge commit on `next`.

`main` is what I've reviewed. I merge PRs into `main` myself; after that, merge `main` back into `next`.

## Validation

Never launch or restart my instance of the app. Ask me to restart it after main-process changes; the renderer hot-reloads on its own.

Debug through `bun run qa` rather than asking me what I see: it launches an isolated instance of its own on a virtual display and drives it by clicking, dragging and typing, and `bun run qa explore` hands that to a Claude Code instance which files what it finds. The `grove-debug` skill has the commands. Never read the UI through tmux.

Reproduce a reported UI bug through the harness and confirm the mechanism before proposing a fix. Guessing from source has been wrong more often than right.

## Directory structure

Electron's three processes are the top-level split, and nothing crosses it except types.

```
src/main/        the Node side: git, nvim RPC, agents, LSP, settings, checkpoints
src/preload/     the bridge; the only place `contextBridge` is touched
src/renderer/    the Svelte 5 app
src/shared/      types that cross IPC, and nothing else — no runtime behaviour
sdk/             the public client SDK (`@grove/plugin-sdk`): protocol, frames, node client
scripts/         bun scripts — plugin build, nvim fetch, icons, the debug harness
resources/       what ships beside the app: bundled nvim, its config, built plugins
tests/           `bun test`; one file per subject, named after it
```

Grove runs on `@neoworks/extension-system`: core features and third-party plugins are both plugins on one kernel. Read the `grove-plugins` skill before touching any plugin, service, IPC route, sidebar view or agent harness — it has the registration rules, the full path layout inside `src/main` and `src/renderer/src`, and the `$state`-on-`Service` trap.

## Style

Neoworks has a shared design system in `/home/moritz/Documents/neoworks/neoworks.dev/packages/ui`, including ready-made components. Scan what it offers before designing anything frontend, reuse what's there, and follow its guidelines for anything new.

## Code style

Readability and maintainability over cleverness. Match the surrounding code when it conflicts with the rules below.

- Give every function a `/** … */` doc comment saying what it does, so it reads clearly at the call site. The signature carries the types — don't restate them in `@param`/`@returns` tags.

  ```ts
  /** Resolves a worktree path to the session that owns it, or null if none does. */
  function findSessionForWorktree(worktreePath: string): AgentSession | null {
  ```

- Comments are technical, concise, and for the reader who arrives later. Add them where skimming the code isn't enough — not to restate it. Don't document a feature you just removed.
  - Good: `// Normalize external IDs before database lookup.`
  - Bad: `// Now we loop through the items and do the thing.`
- Descriptive names, never shortened. `camelCase` for variables, functions, parameters and object fields unless the language or the existing code says otherwise.
  - Good: `recordId`, `customerAccount`, `paymentMethod`
  - Bad: `rid`, `acct`, `pm`
- Explicit control flow over shorthand. Avoid `??`, ternaries and compact conditionals unless they clearly save a lot of repetition.
  - Good: `if (timeout === undefined) { timeout = DEFAULT_TIMEOUT }`
  - Bad: `const timeout = options.timeout ?? DEFAULT_TIMEOUT`
- More than 2 levels of nesting is too much — use guard clauses, early returns, or extracted helpers.
  - Good: `if (!session) { return null }` up front, then the real work unindented.
  - Bad: `if (session) { if (session.worktree) { for (…) { … } } }`
- Short, focused functions, one responsibility each. Prefer a named helper over long inline logic with a comment above it.
- Don't change behaviour, public APIs, data shapes, validation or side effects unless asked.

## Tests

When your changes are written, consider whether they need a test. If so, add one under `tests/` and run `bun test`. Failures mean investigate, not move on.
