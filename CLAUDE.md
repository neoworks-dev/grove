## Git

Commit the worktree first if it's dirty, then write your changes. Short, to-the-point commit title; a body explaining the change when the title doesn't carry it; ask if you're unsure what to write. On a feature branch, only commit what that branch is for.

No trailers, ever: no `Co-Authored-By` on a commit, no "Generated with Claude Code" on a PR.

## Writing

Commits and issues carry only what matters. Say the thing, explain what a reader won't see for themselves, stop. No restating the diff, no summarising what you just said, no section that exists because the format seemed to want one.

Write issues and their comments the way you'd explain it to a colleague, in complete sentences.

- Start with a 2–3 sentence summary: what happened, why, and the fix.
- Use short headings, with short paragraphs of normal prose under them.
- Never join ideas with arrows, slashes, colons or dashes. Write "first X, then Y" instead of "X → Y", and "A and B" instead of "A / B".
- Use at most two code identifiers per sentence. Say what each one does the first time it appears.
- Use bullets only for genuinely separate items, and make each bullet a full sentence.
- Use tables only for numbers or timelines.
- Use one date format everywhere: 2026-10-07 18:28.
- Put error messages, paths and commands in code formatting, and long logs in a collapsed `<details>` block.
- Put side findings in a short "Out of scope" section at the end.

## How we work

One agent at a time, with me giving feedback as it goes. Keep each step small enough for me to read in one sitting, and stop to show me rather than piling up work I then have to catch up on.

`main` is what I've reviewed and what I run Grove from. It stays checked out in the repo root: never switch branches there.

Straight to `main` in the root, no branch: typos, one-liners, and anything that only touches how we work rather than the app — this file, `.claude/skills/`, editor config.

Everything else happens on a branch off `main`, in a worktree under `.worktrees/<branch>` (`git worktree add .worktrees/<branch> -b <branch> main`). Name it `<issue-number>-<slug>` when there is an issue (`12-tab-strip-overflow`), `<slug>` when there isn't. One branch is one thing; anything found along the way gets written down as an issue and stays off the branch, unless the branch can't finish without it.

Before starting on anything, check whether it is already half-built: `git branch` and `git worktree list` for the feature, and read what is on the branch. Sessions end mid-feature, and a branch is where that work is — starting again writes it a second time and loses whatever the first attempt learned. If a branch for it exists, continue on it.

No pull requests unless I ask for one. Review happens here, on the diff, before the merge.

## Issues

Issues on `neoworks-dev/grove` carry goals across sessions. A session ends and its context goes with it; an issue is the only thing that carries a goal to the next one. So:

- Work that finishes in this session, with me here, needs no issue.
- Work that won't finish in one session gets one, however loosely defined it still is.
- Something concrete found along the way, that isn't what we're doing now, gets one instead of being done.

Write them as soon as the list exists, not once the work starts.

Write to GitHub as the bot: issues, comments and labels go through `gh bot` (`gh bot issue comment 12 --body …`), so they show as `neoworks-bot[bot]`, not as me. Plain `gh` is for reading only. The bot as author already says a model wrote it, so no "written by Claude" line in the text. If `gh bot` fails, say so rather than falling back to plain `gh`. It lives in `~/Documents/neoworks/gh-bot`, and `bun run qa` uses it on its own.

Every issue gets a type, a priority, an effort and an area. Type, priority and effort are GitHub's own issue type and the organization's issue fields, never labels.

- **Type** — `Bug` something is broken, `Feature` something new, `Task` everything else.
- **Priority** — `Urgent` drop everything, `High` next up, `Medium` normal, `Low` nice to have.
- **Effort** — `Low` an hour or two, `Medium` about a day, `High` several days or needs splitting.

`gh bot` sets all three at once, by name: `gh bot issue create --type Bug --priority High --effort Low --label area:editor …`, and `gh bot issue edit 12 --priority Urgent` to change them later.

Area is a label, exactly one of:

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

Work is done when it has been shown to work in the app, not when the code is written. Every change goes through `bun run qa` twice: once before, showing the bug or the missing feature, and once after, showing it work, each with a screenshot. The only exception is when I've said it is already tested and working.

A test under `tests/` that fails without the change and passes with it comes on top of that, not instead of it. A test that only exercises a helper, or reads the source text, says nothing about whether the key, button or menu works.

This holds for every agent, and most for subagents on smaller models, where it breaks most easily. An agent that hasn't run the harness hasn't finished, whatever its tests say, so give every subagent this rule in its prompt.

`bun test` passes on the branch either way.

Then hand it over and stop: what changed in a sentence or two, the evidence, and the branch. When it has an issue, the evidence also goes on the issue (`bun run qa evidence --issue <n> --body … --screenshot …`) — that comment is what I read, so it's written for someone who wasn't in the session.

## Merging

I review the branch's diff, and it merges into `main` when I say so — never before, and never without evidence. Merge in the root with `git merge --no-ff <branch>`, so the branch stays one unit in the history; if it conflicts, resolve it in the merge commit. Push `main`. Then remove the worktree and delete the branch, and close its issue with `gh bot issue close <n>`.

Merges land in my running app; when one touches `src/main` or `src/preload`, tell me to restart.

## Validation

Never launch or restart my instance of the app. Ask me to restart it after main-process changes; the renderer hot-reloads on its own.

Debug through `bun run qa` rather than asking me what I see: it launches an isolated instance of its own on a virtual display and drives it by clicking, dragging and typing, and `bun run qa explore` hands that to a Claude Code instance which files what it finds. The `grove-debug` skill has the commands. Never read the UI through tmux.

When I tell you what's happening, that's the reproduction: take it as given and go find the cause, don't re-check what I already saw. Reach for the harness when the code doesn't make the cause clear, or a fix based on reading it didn't work — guessing from source has been wrong often enough that a second guess isn't worth it.

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
