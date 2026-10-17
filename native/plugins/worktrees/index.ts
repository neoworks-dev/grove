// The worktrees plugin: the rail view that lists the open repository's worktrees and switches
// the workspace between them.

import type { Context } from "@neoworks/extension-system";
import gitFork from "@phosphor-icons/core/regular/git-fork.svg";
import { WorktreesService } from "./service";
import WorktreesView from "./WorktreesView.svelte";

export const worktrees = {
  name: "worktrees",
  inject: ["sidebar", "sidecar", "workspace", "commands", "keymap"],
  apply(ctx: Context) {
    const service = new WorktreesService(ctx);
    ctx.sidebar.registerView({
      id: "worktrees",
      title: "Worktrees",
      icon: gitFork,
      order: 3,
      component: WorktreesView,
      props: { worktrees: service, workspace: ctx.workspace, sidecar: ctx.sidecar },
    });
    ctx.commands.register({
      id: "worktrees.show",
      title: "Show worktrees",
      group: "View",
      run: () => ctx.sidebar.open("worktrees"),
    });
    ctx.keymap.bind({ id: "worktrees.show", keys: "ctrl+shift+w", command: "worktrees.show", description: "Show worktrees" });
  },
};
