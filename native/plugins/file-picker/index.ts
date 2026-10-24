// The file picker plugin: `space space` in vim's normal mode, or the "Go to file" command, lists the
// project's files, fuzzy matched as you type, with the top of the selected file beside them.
// Enter opens the file in the editor.

import type { Context } from "@neoworks/extension-system";
import type { PickerItem, PickerLoad, PickerSource } from "../picker/service";
import { fileItems } from "./items";

export const filePicker = {
  name: "file-picker",
  inject: ["commands", "keymap", "picker", "ripgrep", "editor"],
  apply(ctx: Context) {
    ctx.commands.register({
      id: "picker.files",
      title: "Go to file",
      group: "Go",
      keywords: "open find fuzzy picker quick",
      run: () => ctx.picker.open(fileSource(ctx)),
    });
    ctx.keymap.bind({ id: "picker.files", keys: "leader space", command: "picker.files", group: "Go", description: "Find file" });
  },
};

/** Where the picker gets the project's files, and what choosing one does. */
function fileSource(ctx: Context): PickerSource {
  return {
    placeholder: "Go to file",
    mode: "filter",
    load: () => loadFiles(ctx),
    choose: (item: PickerItem) => ctx.editor.open(item.target.path),
  };
}

/** Lists the project's files through ripgrep, or says why that cannot be done. */
async function loadFiles(ctx: Context): Promise<PickerLoad> {
  const root = ctx.ripgrep.root();
  if (root === null) {
    return { items: [], message: "Open a folder to find its files" };
  }
  const listing = await ctx.ripgrep.listFiles(root);
  if (listing.failure !== null) {
    return { items: [], message: listing.failure.message };
  }
  const items = fileItems(root, listing.files);
  if (listing.truncated) {
    return { items, message: `Showing the first ${items.length} files` };
  }
  return { items, message: `${items.length} files` };
}
