// The editor-context-menu plugin: the menu that opens on a right press in an editor, its entries
// in the menu registry under `editor.context`, and the commands for copying the open file's path
// that those entries run.

import { clipboard } from "@neoworks/svelte-gpui";
import type { Context } from "@neoworks/extension-system";
import EditorContextMenu from "./EditorContextMenu.svelte";
import { directoryOf, relativeToWorktree } from "./fileCommands";
import { contextMenuItems } from "./items";

export const editorContextMenu = {
  name: "editor-context-menu",
  inject: ["slots", "commands", "menus", "editor", "sidecar", "workspace"],
  apply(ctx: Context) {
    ctx.menus.registerItems(contextMenuItems((commandId) => ctx.commands.get(commandId) !== undefined));
    ctx.slots.register("overlay", {
      id: "editor.contextMenu",
      order: 12,
      component: EditorContextMenu,
      props: { editor: ctx.editor, menus: ctx.menus, commands: ctx.commands },
    });
    registerFileCommands(ctx);
  },
};

/** The path of the editor's open file, or null when it shows none or text without a file. */
function activePath(ctx: Context): string | null {
  const active = ctx.editor.active();
  if (!active || active.path === "") {
    return null;
  }
  return active.path;
}

/** Registers the commands that copy the open file's path and show it in the file manager. */
function registerFileCommands(ctx: Context): void {
  const hasFile = () => activePath(ctx) !== null;
  ctx.commands.register({
    id: "editor.copyPath",
    title: "Copy the open file's path",
    group: "File",
    when: hasFile,
    run: async () => {
      const path = activePath(ctx);
      if (path !== null) {
        await clipboard.write(path);
      }
    },
  });
  ctx.commands.register({
    id: "editor.copyRelativePath",
    title: "Copy the open file's path from the worktree",
    group: "File",
    when: hasFile,
    run: async () => {
      const path = activePath(ctx);
      const worktree = ctx.workspace.selectedWorktree();
      if (path !== null) {
        await clipboard.write(relativeToWorktree(path, worktree === null ? null : worktree.path));
      }
    },
  });
  ctx.commands.register({
    id: "editor.revealInFileManager",
    title: "Show the open file in the file manager",
    group: "File",
    when: hasFile,
    run: async () => {
      const path = activePath(ctx);
      if (path !== null) {
        await ctx.sidecar.workbench.openExternal(`file://${directoryOf(path)}`);
      }
    },
  });
}
