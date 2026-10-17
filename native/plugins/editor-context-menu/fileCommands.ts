// The commands that act on the path of the open file: copying it and showing it in the system's
// file manager. They live here with the menu that offers them.

/** A file's path from the worktree's root, or the whole path when the file is outside the worktree. */
export function relativeToWorktree(path: string, worktreeRoot: string | null): string {
  if (worktreeRoot !== null && path.startsWith(`${worktreeRoot}/`)) {
    return path.slice(worktreeRoot.length + 1);
  }
  return path;
}

/** The directory a file is in. */
export function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) {
    return "/";
  }
  return path.slice(0, slash);
}
