// The diff plugin: the `diff` service, the `diff` pane type, and the commands and keys that move
// between changes and stage, unstage, revert or preview the hunk under the cursor. Hunks are
// the ones of a file against HEAD or the index, in a diff pane or in a normal editor.

import type { Context } from "@neoworks/extension-system";
import gitDiff from "@phosphor-icons/core/regular/git-diff.svg";
import DiffNotice from "./DiffNotice.svelte";
import DiffPane from "./DiffPane.svelte";
import { gpuiDiffHost } from "./diffHost";
import { DIFF_PANE_TYPE, DiffService } from "./service";

export const diff = {
  name: "diff",
  inject: ["slots", "commands", "keymap", "editor", "layout", "sidecar"],
  apply(ctx: Context) {
    const service = new DiffService(ctx, ctx.editor, ctx.layout, gpuiDiffHost(), {
      onFilesChanged: (handler) => ctx.sidecar.on("event:fs-change", handler),
    });
    ctx.slots.register("main", {
      id: "diff",
      key: DIFF_PANE_TYPE,
      component: DiffPane,
      props: {
        title: (leafId: string) => service.paneTitle(leafId),
        icon: gitDiff,
        diff: service,
        editor: ctx.editor,
        layout: ctx.layout,
      },
    });
    ctx.slots.register("statusbar", { id: "diff.notice", order: 20, component: DiffNotice, props: { diff: service } });
    registerCommands(ctx, service);
  },
};

/** Registers the diff and hunk commands and their keys. */
function registerCommands(ctx: Context, service: DiffService): void {
  const hasFile = () => {
    const active = ctx.editor.active();
    return active !== null && active.path !== "";
  };
  const inDiffOrFile = () => service.hasFocusedDiff() || hasFile();
  ctx.commands.register({
    id: "diff.openFile",
    title: "Diff: show this file's changes",
    group: "Git",
    keywords: "changes compare head",
    when: hasFile,
    run: async () => {
      const active = ctx.editor.active();
      if (active !== null) {
        await service.openFile(active.path, "head");
      }
    },
  });
  ctx.commands.register({
    id: "diff.toggleMode",
    title: "Diff: switch between inline and side by side",
    group: "Git",
    when: () => service.hasFocusedDiff(),
    run: () => service.toggleMode(),
  });
  ctx.commands.register({ id: "diff.nextChange", title: "Git: go to next change", group: "Git", when: inDiffOrFile, run: () => service.stepChange(1) });
  ctx.commands.register({
    id: "diff.previousChange",
    title: "Git: go to previous change",
    group: "Git",
    when: inDiffOrFile,
    run: () => service.stepChange(-1),
  });
  ctx.commands.register({ id: "git.stageHunk", title: "Git: stage hunk at cursor", group: "Git", when: inDiffOrFile, run: () => service.stageHunk() });
  ctx.commands.register({
    id: "git.unstageHunk",
    title: "Git: unstage hunk at cursor",
    group: "Git",
    when: () => service.hasFocusedDiff(),
    run: () => service.unstageHunk(),
  });
  ctx.commands.register({ id: "git.revertHunk", title: "Git: revert hunk at cursor", group: "Git", when: inDiffOrFile, run: () => service.revertHunk() });
  ctx.commands.register({ id: "git.previewHunk", title: "Git: preview hunk at cursor", group: "Git", when: hasFile, run: () => service.previewHunk() });
  ctx.keymap.bind([
    { id: "diff.nextChange", keys: "alt+down", command: "diff.nextChange", description: "Next change" },
    { id: "diff.nextChange.f7", keys: "f7", command: "diff.nextChange", description: "Next change" },
    { id: "diff.previousChange", keys: "alt+up", command: "diff.previousChange", description: "Previous change" },
    { id: "diff.previousChange.f7", keys: "shift+f7", command: "diff.previousChange", description: "Previous change" },
  ]);
}
