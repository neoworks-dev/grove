# Grove

**A native code editor for working alongside AI agents.**

Grove puts your editor, your agents and your Git workflow in one fast window. Run an agent in
every worktree, watch what it changes as it changes it, comment on its diff line by line, and
merge the result without ever leaving the app.

## Fast, because it's native

Grove is drawn by [GPUI](https://www.gpui.rs/), the GPU-accelerated UI framework behind
[Zed](https://zed.dev). There is no browser and no webview: every pane, every diff and every
line of the editor is rendered on the GPU, so Grove opens instantly, scrolls at your
display's refresh rate and stays responsive while agents are rewriting your files.

## What it does

- **Agents in every worktree.** Run Claude Code, Codex or neo side by side, one session per
  worktree, each with its own branch. The Agents view shows every session at a glance and
  which ones are waiting for you.
- **Review as you go.** Every change an agent makes shows up as an inline diff in the editor.
  Leave comments on any changed line, and send them all back to the agent in one message.
- **Prompt blame.** Put the cursor on a line an agent wrote and Grove shows you the prompt
  that produced it.
- **A real editor.** Vim keybindings with which-key hints, tree-sitter highlighting, language
  servers that install themselves, a file picker, project-wide search and a command palette.
- **Git built in.** Stage, commit and browse diffs from the sidebar, see changes in the
  gutter, and create or switch worktrees in one click.
- **GitHub without the browser.** Read issues and pull requests, their checks and reviews, in
  a pane next to your code.
- **Terminals** that live in a tab or in the bottom panel, right beside everything else.

## Built to be extended

Grove is built on [`@neoworks/extension-system`](https://github.com/neoworks-dev/extension-system),
the same plugin kernel that powers the DeepSeek harness. Grove's own features are plugins on
it too: the editor, the agents, the Git view and the GitHub pane all use the same API your
extension gets, so there is nothing an extension can't reach.

And writing one is easy, because Grove's UI is written in
[svelte-gpui](https://github.com/neoworks-dev/svelte-gpui): plain Svelte 5 components,
rendered natively by GPUI. If you know Svelte, you already know how to build for Grove. This
is a complete extension that puts a greeting in the status bar:

```svelte
<!-- Greeting.svelte -->
<script lang="ts">
  import { Text } from "@neoworks/svelte-gpui/ui";
  import { colors } from "@grove/extension";

  let { text }: { text: string } = $props();
</script>

<Text style={{ color: colors.accent }}>{text}</Text>
```

```ts
// hello.ts
import { definePlugin } from "@grove/extension";
import Greeting from "./Greeting.svelte";

definePlugin({
  inject: ["slots"],
  apply(ctx) {
    ctx.slots.register("statusbar", { id: "hello.greeting", component: Greeting, props: { text: "Hello from an extension" } });
  },
});
```

An extension is an ordinary npm package, and one package can bring plugins, themes, settings,
tree-sitter grammars and language servers. Unloading it cleans up everything it added, so
extensions can be turned on and off while Grove runs. See
[`native/docs/extensions.md`](native/docs/extensions.md) for the full guide and
[`native/samples/extensions`](native/samples/extensions) for working examples.

## Running it

```bash
cd native
task install   # JavaScript dependencies
task run       # build the Svelte bundle and the Rust host, then start Grove
task dev       # the same, reloading whenever a source file changes
task test      # JavaScript and Rust tests
```

Guidelines for contributors are in [`AGENTS.md`](AGENTS.md).
