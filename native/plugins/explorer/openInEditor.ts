// How the explorer shows a file: through the editor plugin's `ctx.editor.open(path)`. Without
// an editor plugin loaded, opening a file does nothing.

import type { Context } from "@neoworks/extension-system";

/** Shows the file at an absolute path in the editor, if an editor plugin is loaded. */
export function openInEditor(ctx: Context, absolutePath: string): void {
  const editorService = ctx.get("editor");
  if (!editorService) {
    return;
  }
  editorService.open(absolutePath);
}
