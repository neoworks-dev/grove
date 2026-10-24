// The files git reports as changed, grouped the way the Git changes view lists them: what is
// staged, and what is not (changed tracked files and untracked ones). No host and no state, so
// it runs under `bun test`.

import type { DiffChangeType, DiffFile } from "../../../src/shared/types";
import type { DiffBase } from "../diff/model";
import { buildChangeTree, type ChangeTreeNode } from "../explorer/changeTree";
import { CHANGE_LETTERS } from "../explorer/model";

/** One file in one of the two lists. A file with staged and unstaged changes is an entry in each. */
export interface ChangeEntry {
  /** Names the entry in its list: the same path can be in both. */
  key: string;
  /** The path from the worktree's root. */
  path: string;
  /** Where a renamed file was. */
  oldPath?: string;
  /** The file's name, which the row shows first. */
  name: string;
  /** The directory it is in, which the row shows after the name; empty at the root. */
  directory: string;
  changeType: DiffChangeType;
  /** The letter that says what happened to it. */
  letter: string;
  staged: boolean;
}

export interface ChangeGroups {
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
}

/** Sorts the changed files into the staged and the unstaged list, each by path. */
export function groupChanges(files: DiffFile[]): ChangeGroups {
  const staged: ChangeEntry[] = [];
  const unstaged: ChangeEntry[] = [];
  for (const file of files) {
    const entry = entryOf(file);
    if (file.staged) {
      staged.push(entry);
    } else {
      unstaged.push(entry);
    }
  }
  const byPath = (first: ChangeEntry, second: ChangeEntry) => first.path.localeCompare(second.path);
  return { staged: staged.sort(byPath), unstaged: unstaged.sort(byPath) };
}

/** The entry for one changed file. */
function entryOf(file: DiffFile): ChangeEntry {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  let directory = "";
  if (slash >= 0) {
    directory = file.path.slice(0, slash);
  }
  const entry: ChangeEntry = {
    key: `${file.staged ? "staged" : "unstaged"}:${file.path}`,
    path: file.path,
    name,
    directory,
    changeType: file.changeType,
    letter: CHANGE_LETTERS[file.changeType],
    staged: file.staged,
  };
  if (file.oldPath !== undefined) {
    entry.oldPath = file.oldPath;
  }
  return entry;
}

/** The id of the staged section's node, and of the unstaged one's. */
export const STAGED_SECTION = "staged";
export const UNSTAGED_SECTION = "unstaged";

/** One section of the list: a heading node over the tree of its files. */
function sectionOf(id: string, title: string, entries: ChangeEntry[]): ChangeTreeNode<ChangeEntry> {
  const children = buildChangeTree(
    entries.map((entry) => ({ path: entry.path, change: entry.changeType, item: entry })),
    `${id}:`,
  );
  return { key: id, name: `${title} · ${entries.length}`, relPath: "", isDir: true, section: true, children };
}

/**
 * The tree the view shows: each section with files in it, as a heading over its folders. A file's
 * key is `staged:<path>` or `unstaged:<path>`, the same as its entry's key.
 */
export function sectionsOf(groups: ChangeGroups): ChangeTreeNode<ChangeEntry>[] {
  const sections: ChangeTreeNode<ChangeEntry>[] = [];
  if (groups.staged.length > 0) {
    sections.push(sectionOf(STAGED_SECTION, "Staged Changes", groups.staged));
  }
  if (groups.unstaged.length > 0) {
    sections.push(sectionOf(UNSTAGED_SECTION, "Changes", groups.unstaged));
  }
  return sections;
}

/**
 * What a file's diff compares. Staged changes are shown as the commit would have them, and
 * unstaged ones against the index, so a hunk that is staged leaves the diff. A file git does
 * not know has nothing to compare with, so all of it is new.
 */
export function diffBaseOf(entry: ChangeEntry): DiffBase {
  if (entry.staged) {
    return "staged";
  }
  if (entry.changeType === "untracked") {
    return "head";
  }
  return "index";
}

/** The sentence that says what the commit button will do, or what is missing. */
export function commitHint(stagedCount: number, message: string, branch: string): string {
  if (stagedCount === 0) {
    return "Stage changes first";
  }
  if (message.trim() === "") {
    return "Write a message first";
  }
  if (stagedCount === 1) {
    return `Commit 1 staged file to ${branch} (Ctrl+Enter)`;
  }
  return `Commit ${stagedCount} staged files to ${branch} (Ctrl+Enter)`;
}
