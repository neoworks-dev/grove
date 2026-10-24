// The content search plugin: `space /` in vim's normal mode, or the "Search in files" command,
// searches the text of the project's files with ripgrep as you type, with the lines around the
// selected match beside the results and the match highlighted. Enter opens the file at the match.

import type { Context } from "@neoworks/extension-system";
import type { PickerItem, PickerLoad, PickerSource } from "../picker/service";
import { matchItems } from "./items";

/** The fewest characters a search needs, so one letter does not list half the project. */
const MIN_QUERY_LENGTH = 2;

export const contentSearch = {
  name: "content-search",
  inject: ["commands", "keymap", "picker", "ripgrep", "editor"],
  apply(ctx: Context) {
    ctx.commands.register({
      id: "picker.content",
      title: "Search in files",
      group: "Go",
      keywords: "grep ripgrep find text project live",
      run: () => ctx.picker.open(contentSource(ctx)),
    });
    ctx.keymap.bind({ id: "picker.content", keys: "leader /", command: "picker.content", group: "Go", description: "Search in files" });
  },
};

/** Where the picker gets matching lines, and what choosing one does. */
function contentSource(ctx: Context): PickerSource {
  return {
    placeholder: "Search in files",
    mode: "live",
    load: (query) => searchContent(ctx, query),
    choose: (item: PickerItem) => void ctx.editor.reveal(item.target.path, item.target.line, item.target.column),
  };
}

/** Searches the project for a query, or says why that cannot be done. */
async function searchContent(ctx: Context, query: string): Promise<PickerLoad> {
  const root = ctx.ripgrep.root();
  if (root === null) {
    return { items: [], message: "Open a folder to search its files" };
  }
  if (query.length < MIN_QUERY_LENGTH) {
    return { items: [], message: "Type at least two characters" };
  }
  const search = await ctx.ripgrep.searchContent(root, query);
  if (search.failure !== null) {
    return { items: [], message: search.failure.message };
  }
  const items = matchItems(root, search.matches);
  if (search.truncated) {
    return { items, message: `Showing the first ${items.length} matches` };
  }
  return { items, message: `${items.length} matches` };
}
