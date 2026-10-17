// The git-changes plugin: the Git changes view in the rail, listing what is staged and what is
// not, with the commit box, and the `gitChanges` service behind it. A file's diff opens in a
// diff pane.

import type { Context } from "@neoworks/extension-system";
import gitBranch from "@phosphor-icons/core/regular/git-branch.svg";
import { gpuiDiffHost } from "../diff/diffHost";
import GitChangesView from "./GitChangesView.svelte";
import { GitChangesService } from "./service";

export const gitChanges = {
  name: "git-changes",
  inject: ["sidebar", "sidecar", "workspace", "diff", "editor", "commands", "keymap"],
  apply(ctx: Context) {
    const service = new GitChangesService(ctx, {
      diffs: ctx.diff,
      editor: ctx.editor,
      diffHost: gpuiDiffHost(),
      onFilesChanged: (handler) => ctx.sidecar.on("event:fs-change", handler),
    });
    ctx.sidebar.registerView({
      id: "git",
      title: "Git changes",
      icon: gitBranch,
      order: 2,
      component: GitChangesView,
      props: { changes: service, workspace: ctx.workspace, sidecar: ctx.sidecar },
    });
    ctx.commands.register({
      id: "gitChanges.show",
      title: "Show git changes",
      group: "View",
      run: () => ctx.sidebar.open("git"),
    });
    ctx.keymap.bind({ id: "gitChanges.show", keys: "ctrl+shift+g", command: "gitChanges.show", description: "Show git changes" });
  },
};
