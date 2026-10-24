// The content search's list items, made from the matches ripgrep reports. Pure, so the shape of a
// row is checked without a host.

import type { ContentMatch } from "../ripgrep/parse";
import type { PickerItem } from "../picker/service";

/** The longest line text a row keeps; the rest is cut so one long line cannot cost a lot to draw. */
const MAX_TITLE_LENGTH = 200;

/** One item per matching line, titled with the line and followed by the file and line it is on. */
export function matchItems(root: string, matches: ContentMatch[]): PickerItem[] {
  return matches.map((match, index) => matchItem(root, match, index));
}

/** The item for one match: the line is the title, the file and line the detail, and the match is what the preview highlights. */
export function matchItem(root: string, match: ContentMatch, index: number): PickerItem {
  return {
    id: `${index}:${match.path}:${match.line}`,
    title: match.text.trim().slice(0, MAX_TITLE_LENGTH),
    detail: `${baseName(match.path)}:${match.line + 1}`,
    location: `${match.path}:${match.line + 1}`,
    target: { path: `${root}/${match.path}`, line: match.line, column: match.column, endColumn: match.endColumn },
  };
}

/** The last segment of a path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
