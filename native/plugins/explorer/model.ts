// The explorer's tree as plain data: the directories that have been listed, and the git
// change each path has. Nothing here talks to the sidecar or to Svelte, so the rules for
// sorting, for what a file system change invalidates and for which folders carry a change
// marker run under `bun test`. Paths are relative to the worktree root, with "" as the root.

import type { DiffChangeType, FileNode } from "../../../src/shared/types";

/** What the watcher reports about one path, as the sidecar's `event:fs-change` carries it. */
export interface FileSystemChange {
  worktreeId: string;
  relPath: string;
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
}

/** The directory a path is in, "" for a path at the root. */
export function parentOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  if (slash < 0) {
    return "";
  }
  return relPath.slice(0, slash);
}

/** A name inside a directory. */
export function joinPath(directory: string, name: string): string {
  if (directory === "") {
    return name;
  }
  return `${directory}/${name}`;
}

/** The directories above a path, outermost first: `a/b/c.ts` has `a` and `a/b`. */
export function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split("/");
  const ancestors: string[] = [];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = joinPath(current, part);
    ancestors.push(current);
  }
  return ancestors;
}

/** Folders before files, then by name without regard to case. */
export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((first, second) => {
    if (first.isDir !== second.isDir) {
      if (first.isDir) {
        return -1;
      }
      return 1;
    }
    const firstName = first.name.toLowerCase();
    const secondName = second.name.toLowerCase();
    if (firstName < secondName) {
      return -1;
    }
    if (firstName > secondName) {
      return 1;
    }
    return 0;
  });
}

/** Git changes from the one a folder shows first to the one it shows last, when several lie below it. */
const CHANGE_STRENGTH: readonly DiffChangeType[] = ["deleted", "modified", "renamed", "added", "untracked"];

/** The letter that says what a git change did to a file. */
export const CHANGE_LETTERS: Record<DiffChangeType, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

/** Whichever of two changes a folder over both shows; an absent one yields to the other. */
export function strongerChange(first: DiffChangeType | undefined, second: DiffChangeType | undefined): DiffChangeType | undefined {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }
  if (CHANGE_STRENGTH.indexOf(second) < CHANGE_STRENGTH.indexOf(first)) {
    return second;
  }
  return first;
}

export class ExplorerModel {
  private directories = new Map<string, FileNode[]>();
  private changes = new Map<string, DiffChangeType>();

  /** Forgets every listing and change, for when another worktree is shown. */
  reset(): void {
    this.directories.clear();
    this.changes.clear();
  }

  /** Stores a directory's listing, sorted. */
  setDirectory(relPath: string, nodes: FileNode[]): void {
    this.directories.set(relPath, sortNodes(nodes));
  }

  /** Forgets a directory's listing and those of the directories below it. */
  forgetDirectory(relPath: string): void {
    for (const loaded of [...this.directories.keys()]) {
      if (loaded === relPath || loaded.startsWith(`${relPath}/`)) {
        this.directories.delete(loaded);
      }
    }
  }

  /** Whether a directory has been listed. */
  hasDirectory(relPath: string): boolean {
    return this.directories.has(relPath);
  }

  /** A directory's entries, or undefined when it has not been listed. */
  children(relPath: string): FileNode[] | undefined {
    return this.directories.get(relPath);
  }

  /** The directories that have been listed, the root included once it has. */
  loadedDirectories(): string[] {
    return [...this.directories.keys()];
  }

  /** Replaces the git changes. A path both staged and unstaged keeps one marker. */
  setChanges(changes: { path: string; changeType: DiffChangeType }[]): void {
    this.changes.clear();
    for (const change of changes) {
      this.changes.set(change.path, change.changeType);
    }
  }

  /** The git change of a path, or undefined for an unchanged one. */
  changeOf(relPath: string): DiffChangeType | undefined {
    return this.changes.get(relPath);
  }

  /**
   * The change each folder shows: the strongest change anywhere below it, as VS Code colours
   * every folder above a changed file, whether the folder is open or not.
   */
  directoryChanges(): Map<string, DiffChangeType> {
    const shown = new Map<string, DiffChangeType>();
    for (const [changedPath, change] of this.changes) {
      for (const ancestor of ancestorsOf(changedPath)) {
        shown.set(ancestor, strongerChange(shown.get(ancestor), change) as DiffChangeType);
      }
    }
    return shown;
  }

  /**
   * The directory listings a file system change makes stale, to be read again. Only a
   * listing that has been loaded matters, and a removed directory is forgotten with
   * everything under it. A file's contents changing leaves every listing as it is.
   */
  staleDirectories(change: FileSystemChange): string[] {
    if (change.type === "change") {
      return [];
    }
    if (change.type === "unlinkDir") {
      this.forgetDirectory(change.relPath);
    }
    const parent = parentOf(change.relPath);
    if (!this.directories.has(parent)) {
      return [];
    }
    return [parent];
  }
}
