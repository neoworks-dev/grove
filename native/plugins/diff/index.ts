// The diff plugin: the `diff` service, the `diff` pane type, and the commands and keys that move
// between changes and stage, unstage, revert or preview the hunk under the cursor. Hunks are
// the ones of a file against HEAD or the index. A file's changes are a diff tab of an ordinary
// editor pane, inline or side by side as the `mode` setting says, with a strip of buttons over it.

import type { Context } from "@neoworks/extension-system";
import gitDiff from "@phosphor-icons/core/regular/git-diff.svg";
import { defineSettings, setting } from "../../kernel/settings";
import DiffNotice from "./DiffNotice.svelte";
import InlineDiffBar from "./InlineDiffBar.svelte";
import DiffPane from "./DiffPane.svelte";
import { gpuiDiffHost } from "./diffHost";
import type { DiffMode } from "./model";
import { DIFF_PANE_TYPE, DiffService } from "./service";

export const diffSettings = defineSettings({
  mode: setting.enum({
    label: "Diff layout",
    description: "How a diff tab starts: the removed lines between the new ones, or the old text beside the new.",
    default: "inline",
    live: true,
    options: [
      { value: "inline", label: "Inline" },
      { value: "split", label: "Side by side" },
    ],
  }),
});

export const diff = {
  name: "diff",
  Config: diffSettings,
  inject: ["slots", "commands", "keymap", "editor", "layout", "sidecar", "settings"],
  apply(ctx: Context, config: { mode: DiffMode }) {
    const service = new DiffService(ctx, ctx.editor, ctx.layout, gpuiDiffHost(), {
      onFilesChanged: (handler) => ctx.sidecar.on("event:fs-change", handler),
    });
    service.configure(config.mode);
    ctx.settings.onLive((change) => service.configure((change.config as unknown as { mode: DiffMode }).mode));
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
    // Drawn in the strip over a diff in an editor; a plugin adds what belongs to the file's changes.
    ctx.slots.declare("diff.inline.actions", "list");
    ctx.slots.register("editor.breadcrumbs", { id: "diff.inline", order: 10, component: InlineDiffBar, props: { diff: service, editor: ctx.editor } });
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
    keywords: "changes compare head inline",
    when: hasFile,
    run: async () => {
      const active = ctx.editor.active();
      if (active !== null) {
        await service.showInEditor(active.path, "head");
      }
    },
  });
  ctx.commands.register({
    id: "diff.toggleInline",
    title: "Diff: show or hide this file's changes",
    group: "Git",
    keywords: "changes compare head inline toggle",
    when: hasFile,
    run: () => service.toggleInEditor(),
  });
  ctx.commands.register({
    id: "diff.openPane",
    title: "Diff: open this file's changes in a pane",
    group: "Git",
    keywords: "changes compare head split side by side",
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
    when: () => service.hasFocusedDiff() || service.hasFocusedDiffTab(),
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
