// The files panel of one chat: the changes git reports for the session's worktree, merged with
// the files the session's agents touched, and the diff of the file the user opened. Where the
// changes come from is a `ChangesSource`, which is Grove's sidecar in the app and a fake in tests.

import type { DiffLine } from "@suite/protocol/types";
import type { DiffFile, Worktree } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { ChatSession } from "./chatSession";
import type { CallDiff } from "./calls";
import { fileEntries, relativize, type FileEntry } from "./files";
import { diffLinesOf } from "./lineDiff";

/** Where a worktree's changes and their diffs come from. */
export interface ChangesSource {
  /** The files that differ from HEAD in the worktree, staged, unstaged and untracked. */
  changedFiles(worktreeId: string): Promise<DiffFile[]>;
  /** The lines of one changed file's diff against HEAD. */
  diffLines(worktreeId: string, file: DiffFile): Promise<DiffLine[]>;
}

/** The diff the panel shows in place of the list. */
export interface OpenDiff {
  path: string;
  lines: readonly DiffLine[];
}

export class FilesModel {
  private source: ChangesSource;
  private worktrees: () => Worktree[];
  private chat: ChatSession;
  private sessionDirectory: () => string | undefined;
  private changes: readonly DiffFile[] | undefined;
  private shownDiff: OpenDiff | null = null;
  private failure: string | null = null;
  private refreshing = false;
  private refreshAgain = false;
  private signal: ChangeSignal = createChangeSignal();

  /** `sessionDirectory` says where the session works; its worktree is the one whose changes are listed. */
  constructor(source: ChangesSource, worktrees: () => Worktree[], chat: ChatSession, sessionDirectory: () => string | undefined) {
    this.source = source;
    this.worktrees = worktrees;
    this.chat = chat;
    this.sessionDirectory = sessionDirectory;
  }

  /** The worktree the session works in: the one whose directory holds the session's, the innermost if several do. */
  worktree(): Worktree | null {
    const directory = this.sessionDirectory();
    if (directory === undefined) {
      return null;
    }
    let found: Worktree | null = null;
    for (const candidate of this.worktrees()) {
      const holds = directory === candidate.path || directory.startsWith(`${candidate.path}/`);
      if (holds && (found === null || candidate.path.length > found.path.length)) {
        found = candidate;
      }
    }
    return found;
  }

  /** The changed and touched files, git's first. Reactive. */
  entries(): FileEntry[] {
    this.signal.track();
    const worktree = this.worktree();
    let base = this.sessionDirectory();
    if (worktree !== null) {
      base = worktree.path;
    }
    if (base === undefined) {
      return [];
    }
    return fileEntries(base, this.changes, this.chat.touches().touched);
  }

  /** The diff being shown, or null while the list is. Reactive. */
  diff(): OpenDiff | null {
    this.signal.track();
    return this.shownDiff;
  }

  /** Why the last diff could not be read, or null. Reactive. */
  error(): string | null {
    this.signal.track();
    return this.failure;
  }

  /** Whether a file has a diff to show: git reports a change in it, or the session's calls say what they changed. */
  canDiff(entry: FileEntry): boolean {
    if (entry.file !== undefined && this.worktree() !== null) {
      return true;
    }
    return this.changesTo(entry).length > 0;
  }

  /** What the session's tool calls changed in a file, from their own old and new text, oldest first. */
  private changesTo(entry: FileEntry): CallDiff[] {
    let base = this.sessionDirectory();
    const worktree = this.worktree();
    if (worktree !== null) {
      base = worktree.path;
    }
    if (base === undefined) {
      return [];
    }
    const directory = base;
    return this.chat.fileChanges().filter((change) => relativize(directory, change.path) === entry.rel);
  }

  /** Asks git for the changes again; one ask at a time, and one more after it when asked meanwhile. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    const worktree = this.worktree();
    if (worktree === null) {
      this.setChanges(undefined);
      return;
    }
    this.refreshing = true;
    try {
      this.setChanges(await this.source.changedFiles(worktree.id));
    } catch {
      this.setChanges(undefined);
    } finally {
      this.refreshing = false;
    }
    if (this.refreshAgain) {
      this.refreshAgain = false;
      await this.refresh();
    }
  }

  /** Shows how a file changed in a diff tab: the session's own change to it, else the file against HEAD. */
  open(entry: FileEntry): void {
    let base = this.sessionDirectory();
    const worktree = this.worktree();
    if (worktree !== null) {
      base = worktree.path;
    }
    if (base === undefined) {
      return;
    }
    this.chat.openDiff(`${base.replace(/\/+$/, "")}/${entry.rel}`);
  }

  /**
   * Opens a file's diff in place of the list: git's, or for a file git sees no change in, the
   * changes the session's calls made to it. A file with neither does nothing.
   */
  async showDiff(entry: FileEntry): Promise<void> {
    const worktree = this.worktree();
    if (entry.file === undefined || worktree === null) {
      this.showOwnChanges(entry);
      return;
    }
    try {
      const lines = await this.source.diffLines(worktree.id, entry.file);
      this.failure = null;
      this.shownDiff = { path: entry.rel, lines: this.withNote(lines) };
    } catch (error) {
      this.failure = describeError(error);
    }
    this.signal.notify();
  }

  /** Shows what the session's calls changed in a file, one change after the other. */
  private showOwnChanges(entry: FileEntry): void {
    const changes = this.changesTo(entry);
    if (changes.length === 0) {
      return;
    }
    const lines = changes.flatMap((change) => diffLinesOf(change.oldText, change.newText));
    this.failure = null;
    this.shownDiff = { path: entry.rel, lines: this.withNote(lines) };
    this.signal.notify();
  }

  /** Goes back from a diff to the list. */
  closeDiff(): void {
    this.shownDiff = null;
    this.failure = null;
    this.signal.notify();
  }

  /** A file whose diff is empty (a binary, or changes only in mode) says so instead of showing nothing. */
  private withNote(lines: DiffLine[]): DiffLine[] {
    if (lines.length > 0) {
      return lines;
    }
    return [{ kind: "context", text: "no changes to show" }];
  }

  /** Keeps a new answer from git and redraws. */
  private setChanges(changes: readonly DiffFile[] | undefined): void {
    this.changes = changes;
    this.signal.notify();
  }
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
