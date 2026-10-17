// What git-gutter asks git, through the native host's commands (`src/git.rs`). Kept apart from
// the service so the service runs under `bun test` with a fake.

import { invoke } from "@neoworks/svelte-gpui";
import type { Blame, FileChanges } from "./changes";

/** The questions about a file that git answers. */
export interface GitHost {
  /** How the file on disk differs from HEAD. */
  fileChanges(path: string): Promise<FileChanges>;
  /** The commit that last changed a line (counted from 1), or null when git has none to name. */
  blameLine(path: string, line: number): Promise<Blame | null>;
}

/** Git as the native host answers it. */
export function gpuiGitHost(): GitHost {
  return {
    fileChanges: (path) => invoke<FileChanges>("git_file_changes", { path }),
    blameLine: (path, line) => invoke<Blame | null>("git_blame_line", { path, line }),
  };
}
