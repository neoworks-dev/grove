// How the explorer shows a file in the editor. The editor plugin offers `ctx.editor.open(path)`
// on an `editor` service once it has one. Until then the open file is the editor element's
// `path`, which the editor plugin's shared state holds, so this sets that.

import type { Context } from "@neoworks/extension-system";
import { editorState } from "../editor/editorState.svelte";

/** Shows the file at an absolute path in the editor. */
export function openInEditor(ctx: Context, absolutePath: string): void {
  const editorService = ctx.get("editor");
  if (editorService) {
    editorService.open(absolutePath);
    return;
  }
  editorState.path = absolutePath;
}
