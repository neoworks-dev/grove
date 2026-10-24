// The file picker's list items, made from the paths ripgrep lists. Pure, so the shape of a row is
// checked without a host.

import type { PickerItem } from "../picker/service";

/** One item per path relative to `root`: the file name is the title, the directory is dim text after it. */
export function fileItems(root: string, relativePaths: string[]): PickerItem[] {
  return relativePaths.map((relativePath) => fileItem(root, relativePath));
}

/** The item for one path. The whole relative path is searchable, the file name counts for more. */
export function fileItem(root: string, relativePath: string): PickerItem {
  const slash = relativePath.lastIndexOf("/");
  const name = relativePath.slice(slash + 1);
  let directory = "";
  if (slash >= 0) {
    directory = relativePath.slice(0, slash);
  }
  return {
    id: relativePath,
    title: name,
    detail: directory,
    extra: relativePath,
    location: relativePath,
    target: { path: `${root}/${relativePath}`, line: 0, column: 0 },
  };
}
