// The explorer plugin: the file tree of the shown worktree as the first view on the rail.

import type { Context } from "@neoworks/extension-system";
import folder from "@phosphor-icons/core/regular/folder.svg";
import ExplorerView from "./ExplorerView.svelte";
import { openInEditor } from "./openInEditor";
import { ExplorerService } from "./service";

export const explorer = {
  name: "explorer",
  inject: ["sidebar", "sidecar", "workspace", "commands", "keymap"],
  apply(ctx: Context) {
    const service = new ExplorerService(ctx, { openInEditor: (absolutePath) => openInEditor(ctx, absolutePath) });
    ctx.sidebar.registerView({
      id: "explorer",
      title: "Explorer",
      icon: folder,
      order: 1,
      component: ExplorerView,
      props: { explorer: service, workspace: ctx.workspace, sidecar: ctx.sidecar },
    });
    ctx.commands.register({
      id: "explorer.show",
      title: "Show explorer",
      group: "View",
      run: () => ctx.sidebar.open("explorer"),
    });
    ctx.keymap.bind({ id: "explorer.show", keys: "ctrl+shift+e", command: "explorer.show", description: "Show explorer" });
  },
};
