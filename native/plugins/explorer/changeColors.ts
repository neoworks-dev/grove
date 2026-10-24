// The colour a git change gives a file's name and its letter, as the explorer draws it and as
// every other tree of changed files does.

import type { DiffChangeType } from "../../../src/shared/types";
import { colors } from "../theme/tokens";

/** The colour of a git change in the active theme. Read at draw time, so it follows a theme switch. */
export function changeColor(change: DiffChangeType): string {
  switch (change) {
    case "added":
      return colors.green;
    case "modified":
      return colors.amber;
    case "deleted":
      return colors.red;
    case "renamed":
      return colors.blue;
    case "untracked":
      return colors.green;
  }
}
