// The explorer plugin: the file tree of the shown worktree as the first view on the rail.

import type { Context } from "@neoworks/extension-system";
import folder from "@phosphor-icons/core/regular/folder.svg";
import { defineSettings, setting } from "../../kernel/settings";
import ExplorerView from "./ExplorerView.svelte";
import { DEFAULT_ICON_SET_ID, ICON_SETS } from "./fileIcons";
import { openInEditor } from "./openInEditor";
import { ExplorerService } from "./service";

export const explorerSettings = defineSettings({
  iconSet: setting.enum({
    label: "File icons",
    description: "The icons the explorer draws files and folders with.",
    default: DEFAULT_ICON_SET_ID,
    options: ICON_SETS.map((set) => ({ value: set.id, label: set.label })),
    live: true,
  }),
});

export const explorer = {
  name: "explorer",
  Config: explorerSettings,
  inject: ["sidebar", "sidecar", "workspace", "commands", "keymap", "settings"],
  apply(ctx: Context, config: { iconSet: string }) {
    const service = new ExplorerService(ctx, { openInEditor: (absolutePath) => openInEditor(ctx, absolutePath) });
    service.setIconSet(config.iconSet);
    ctx.settings.onLive((change) => service.setIconSet(change.config.iconSet as string));
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
    ctx.commands.register({
      id: "explorer.reveal",
      title: "Show the open file in the explorer",
      group: "View",
      keywords: "reveal locate",
      run: (relPath: unknown) => {
        const target = typeof relPath === "string" ? relPath : activeFileRelativePath(ctx);
        if (target !== null) {
          service.requestReveal(target);
        }
        ctx.sidebar.open("explorer");
      },
    });
    ctx.keymap.bind({ id: "explorer.show", keys: "ctrl+shift+e", command: "explorer.show", description: "Show explorer" });
  },
};

/** The path of the editor's active file inside the shown worktree, or null when there is none. */
function activeFileRelativePath(ctx: Context): string | null {
  const active = ctx.get("editor")?.active();
  const worktree = ctx.workspace.selectedWorktree();
  if (!active || active.path === "" || worktree === null) {
    return null;
  }
  if (!active.path.startsWith(`${worktree.path}/`)) {
    return null;
  }
  return active.path.slice(worktree.path.length + 1);
}
