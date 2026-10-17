// The editor plugin: the GPUI editor in the `main` slot, its file status in the status bar, and
// the `editor.save` command with the key bindings that run it, and the undo, redo and select-all
// commands the Edit menu names.

import type { Context } from "@neoworks/extension-system";
import EditorFileStatus from "./EditorFileStatus.svelte";
import EditorMain from "./EditorMain.svelte";
import { editorState } from "./editorState.svelte";

export const editor = {
  name: "editor",
  inject: ["slots", "commands", "keymap"],
  apply(ctx: Context) {
    ctx.slots.register("main", { id: "editor", key: "editor", component: EditorMain, props: { title: "Editor" } });
    ctx.slots.register("statusbar", { id: "editor.file", order: 10, component: EditorFileStatus });
    ctx.commands.register({
      id: "editor.save",
      title: "Save file",
      group: "Editor",
      run: () => editorState.save(),
    });
    registerEditCommands(ctx);
    // The editor takes Ctrl-S itself, so these use keys it leaves alone and reach the keymap.
    ctx.keymap.bind([
      { id: "editor.save", keys: "ctrl+alt+s", command: "editor.save", description: "Save file" },
      { id: "editor.save.chord", keys: "ctrl+k f2", command: "editor.save", description: "Save file" },
    ]);
    ctx.effect(() => () => editorState.reset(), "editor state");
  },
};

/** The commands the Edit menu names that the editor can carry out by itself. */
function registerEditCommands(ctx: Context): void {
  const commands: [string, string, string][] = [
    ["edit.undo", "Undo", "undo"],
    ["edit.redo", "Redo", "redo"],
    ["edit.selectAll", "Select all", "select_all"],
  ];
  for (const [id, title, type] of commands) {
    ctx.commands.register({
      id,
      title,
      group: "Edit",
      when: () => editorState.hasEditor(),
      run: () => editorState.send(type),
    });
  }
}
