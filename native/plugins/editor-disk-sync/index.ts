// The editor-disk-sync plugin: when the sidecar's watcher sees a file change on disk, such as an
// agent's edit, the document open on that file takes the new text. A document with unsaved changes
// keeps them. It is its own plugin so the editor does not depend on the sidecar.

import type { Context } from "@neoworks/extension-system";
import type { FileSystemChange } from "../explorer/model";
import type { Worktree } from "../../../src/shared/types";

export const editorDiskSync = {
  name: "editor-disk-sync",
  inject: ["editor", "sidecar", "workspace"],
  apply(ctx: Context) {
    ctx.sidecar.on("event:fs-change", (payload) => {
      const change = payload as FileSystemChange;
      if (change.type !== "change" && change.type !== "add") {
        return;
      }
      const path = absolutePathOf(change, ctx.workspace.worktrees());
      if (path !== null) {
        void ctx.editor.syncFile(path);
      }
    });
  },
};

/** The absolute path a watcher change is about, or null when its worktree is not known. */
function absolutePathOf(change: FileSystemChange, worktrees: Worktree[]): string | null {
  const worktree = worktrees.find((candidate) => candidate.id === change.worktreeId);
  if (worktree === undefined) {
    return null;
  }
  return `${worktree.path}/${change.relPath}`;
}
