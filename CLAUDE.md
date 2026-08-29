## Git

You're allowed to use git. Every time you make a big change, commit the current worktree if it's dirty before changing anything, then write your changes, choose a short to-the-point commit message, and push to the remote repository. If you are unsure about what to write in the commit message, ask for help. Write an explanation of the change in the body of the commit message if it is not obvious from the title. Always mention that a commit was made by you and not an actual human. In case you ever find yourself in a feature branch only commit the changes this branch was for and then merge it back into main.

## Validation

Never launch the app yourself. I run it, and I run it with `GROVE_DEBUG=1`.

Once it's running you can attach to it and drive it yourself instead of asking me what I see. Don't inspect the UI via tmux, and don't guess at UI behaviour from reading code — attach and look.

```
bun scripts/grove-debug.ts ping                  # is it reachable
bun scripts/grove-debug.ts state                 # review + editor state
bun scripts/grove-debug.ts windows               # nvim tabs/windows/buffers/diff flags
bun scripts/grove-debug.ts eval '<js>'           # anything in the renderer
bun scripts/grove-debug.ts lua '<lua>'           # anything in the editor

bun scripts/grove-debug.ts agent start '<prompt>'
bun scripts/grove-debug.ts agent permissions | allow | deny '<why>'
bun scripts/grove-debug.ts review list | open | decide | comment | finish

bun scripts/grove-debug.ts scenarios             # replayable end-to-end flows
bun scripts/grove-debug.ts scenario review-e2e   # drives a whole gated review
```

`debug.renderer.eval` reaches `window.__grove_debug` (ctx, store, review, keymap, layout, inlineEdit, nvimRegistry) and `window.workbench.*`, so you can read any app state and call any IPC the UI calls.

`ctx` is the renderer's kernel context. `ctx.fiber.getEffects()` lists everything currently installed, `ctx.registry.values()` lists the mounted plugins, and `ctx.panes` / `ctx.commands` / `ctx.sidebar` / `ctx.editor` / `ctx.panel` reach the services they contribute into.

Ask me to restart the app after changing main-process code; the renderer hot-reloads on its own.

If a UI bug is reported, reproduce it through the harness and confirm the mechanism before proposing a fix. Guessing from source has been wrong more often than right.

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
  the host services (`sidebar`, `editor`, `panel`) and the core feature plugins.
- `src/main/kernel/` + `src/main/routes/` — the main root context, the service contracts, and
  the IPC surface split one plugin per domain.
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
