## Git

You're allowed to use git. Every time you make a big change, commit the current worktree if it's dirty before changing anything, then write your changes, choose a short to-the-point commit message, and push to the remote repository. If you are unsure about what to write in the commit message, ask for help. Write an explanation of the change in the body of the commit message if it is not obvious from the title. Always mention that a commit was made by you and not an actual human. In a feature branch, only commit the changes that branch was for.

## Issues and branches

Work lives in GitHub issues on `neoworks-dev/grove`, not in a file in the repo.

Anything more than a tiny change: open an issue (`gh issue create`) with the labels below, branch off `main` as `<issue-number>-<slug>` (e.g. `12-tab-strip-overflow`), then open a PR towards `main` with `Closes #12` in the body. Typos, one-liners and doc tweaks go straight to `main`.

Labels are two axes. Type is GitHub's default `bug` or `enhancement`. Area is exactly one of:

- `area:editor` — nvim surface: buffers, rendering, bundled config
- `area:agents` — agent runtime, chat pane, composer, review flow
- `area:panes` — layout, splits, dividers, pane chrome
- `area:sidebar` — the rail and its views
- `area:git` — git changes, worktrees, checkpoints
- `area:terminal` — terminal pane
- `area:extensions` — plugin host, extensions view
- `area:ui` — app shell: top bar, menus, theming

Two areas is fine when an issue genuinely spans them; three means split it.

## Validation

Never launch the app yourself. I run it, and I run it with `GROVE_DEBUG=1`.

Once it's running, attach to it and drive it yourself instead of asking me what I see — read the `grove-debug` skill (`.claude/skills/grove-debug/SKILL.md`) for the commands, the renderer state they reach, and the on-disk agent event log. Don't inspect the UI via tmux, and don't guess at UI behaviour from reading code.

If a UI bug is reported, reproduce it through the harness and confirm the mechanism before proposing a fix. Guessing from source has been wrong more often than right.

Ask me to restart the app after changing main-process code; the renderer hot-reloads on its own.

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

Inside `src/main`:

- `kernel/` — the root context, the service contracts, route registration.
- `routes/` — the IPC surface, one file per domain (`git`, `agents`, `review`, …).
  Adding an IPC method means adding it here, not in `index.ts`.
- `agents/` — the agent runtime: `store.ts` (sessions + the append-only event log),
  `service.ts` (what the renderer drives), `reviewBridge.ts`, `tools.ts` (grove's own
  tools), `roster.ts` + `handoffBridge.ts` (agents talking to each other).
  `harnesses/` holds one plugin per coding agent; see the extension-system section.
- `api/` — the external API: socket, dispatcher, pairing, per-scope routes under
  `api/routes/` (including `debug.ts`, which only mounts under `GROVE_DEBUG=1`).
- Flat files at the root of `src/main` are the services themselves (`git.ts`,
  `nvimRpc.ts`, `lsp.ts`, `review.ts`, …) — routes stay thin and call into these.

Inside `src/renderer/src`:

- `kernel/` — the renderer root context and the core feature plugins; `kernel/plugins/`
  is where a feature lives, `kernel/services/` is what hosts it.
- `lib/` — the non-visual half: stores (`*.svelte.ts`), keymap and binding
  resolution, and `lib/agents/` (the transcript fold, session store, catalogs,
  tool rendering — the logic behind the agent pane).
- `components/` — components shared across features. A component only one feature
  renders belongs in that feature's plugin directory instead.
- `plugins/` — the sandboxed third-party host (one Worker per plugin record), not
  to be confused with `kernel/plugins/`, which is grove's own features.

Where a given plugin, service or sidebar view lives is spelled out in the next
section.

## Extension system

Grove runs on `@neoworks/extension-system`. Core features and third-party plugins are both
plugins on one kernel — read its skill (`skills/extension-system/SKILL.md` in that package)
before touching plugin code.

Two rules carry everything here:

- **Register through `ctx.effect`.** Anything a plugin does to the outside world hands back
  the inverse. Renderer registries (`ctx.commands.register`, `ctx.panes.register`, …) already
  return a disposer, so wrapping them is a one-liner. Raw APIs — `setInterval`, a DOM listener,
  a `Worker`, `ipcMain.handle` — must return their own.
- **Declare what you need through `inject`.** A plugin contributing to the sidebar injects
  `'sidebar'` and only runs while it exists.

Where things live:

- `src/renderer/src/kernel/` — the renderer root context, the registries published as services,
  the host services (`editor`, `panel`) and the core feature plugins.
- `src/renderer/src/kernel/plugins/sidebar/` — the sidebar host: the service, the rail-launcher
  registry and `ActivityBar.svelte`. Each view it shows is a sibling plugin directory
  (`explorer/`, `worktrees/`, `gitChanges/`, `agents/`, `checkpoints/`, `extensions/`, `setup/`)
  holding its plugin and the components only it renders. Shared components stay in
  `src/renderer/src/components/`.
- `src/main/kernel/` + `src/main/routes/` — the main root context, the service contracts, and
  the IPC surface split one plugin per domain.
- `src/main/agents/` — the agent runtime: the session store and event log, the service the
  renderer drives, the review bridge, and grove's own tools. `harnesses/` holds one plugin per
  coding agent (`claude`, `codex`, `pi`), each registering a descriptor into the `harnesses`
  registry. Adding another means adding a file there and listing it in `src/main/routes/index.ts`.
- `src/renderer/src/plugins/` — the sandboxed third-party host: one Worker and one fiber per
  plugin record.

Do not put `$state` class fields on a `Service` subclass. Svelte compiles them into private
fields, and `isolate`/`intercept` re-create the service through `Object.create()`, which then
throws on the inherited accessor. Keep reactive state in the `.svelte.ts` registry the service
delegates to.

## Style

Neoworks uses a shared design system defined in the /home/moritz/Documents/neoworks/neoworks.dev/packages/ui package. This package also contains some predefined components that can be reused throughout the applications. When creating new components, try to reuse existing ones as much as possible, and if you need to create new ones, follow the design system guidelines. Whenever you want to design anything frontend scan what neoworks/ui offers first.

## Code Style

When editing or generating code, prioritize readability and maintainability over cleverness.

Rules:

- Comments are important, when writing a function add a JSDoc style comment to it so people know what the function does even without having to open the file it's in.

- When you are writing comments assume they will be read in the future when your changes are done. If you remove a feature entirely there's no point adding a comment about something that won't be there anymore in the future.

- Preserve descriptive names. Do not shorten identifiers.
  - Good: `recordId`, `customerAccount`, `paymentMethod`
  - Bad: `rid`, `acct`, `pm`

- Use `camelCase` for variables, functions, parameters, and object fields unless the language, framework, or existing codebase requires another convention.
- Prefer explicit control flow over shorthand.
- Avoid `??`, ternary `?:`, and compact conditional expressions unless they clearly prevent a large amount of repetitive code without reducing readability.
- Do not deeply nest logic.
  - More than 2 indentation levels is too much.
  - Use guard clauses, early returns, helper functions, or extracted validation steps instead.

- Keep functions short and focused.
  - Split large functions into smaller functions instead of writing one huge function.
  - Each function should have one clear responsibility.

- Add comments only when the code is not immediately readable when skimming.
- Comments must be technical, concise, and useful.
  - Good: `// Normalize external IDs before database lookup.`
  - Bad: `// Now we loop through the items and do the thing.`

- Do not add obvious comments that restate the code.
- Prefer clearly named helper functions over long inline logic with comments.
- Do not change behavior, public APIs, data shapes, validation rules, or side effects unless explicitly asked.
- Match the surrounding code style when it conflicts with these rules.

## Tests

After having written all your changes, think about if any of these changes require writing a test, if so, create a test in the tests/ directory and run the `bun test` command to see if any of the tests are failing, if they do, investigate further, otherwise everything is fine and you're done.
