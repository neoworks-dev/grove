// The `gitChanges` service: the files changed in the shown worktree, staged and not, and what
// the Git changes view does with them: stage, unstage, discard, commit, and open a file's diff.
// The lists come from the sidecar's `git:changedFiles` and follow the watcher; edits made in the
// index by hunk actions or commits are read again straight away, since the watcher does not see
// the index. State is plain fields with a change signal, never `$state`.

import { Service, type Context } from "@neoworks/extension-system";
import type { DiffFile } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { DiffHost } from "../diff/diffHost";
import type { DiffBase } from "../diff/model";
import { diffBaseOf, groupChanges, type ChangeEntry, type ChangeGroups } from "./model";

declare module "@neoworks/extension-system" {
  interface Context {
    gitChanges: GitChangesService;
  }
}

/** How long file system events are gathered before the changes are read again. */
const REFRESH_DELAY_MS = 300;

/** What the service asks of the diff plugin. */
export interface ChangesDiffs {
  /** Shows how a file differs from a base, drawn over the file in an editor pane. */
  showInEditor(path: string, base: DiffBase): Promise<boolean>;
  /** Reads the git side of every open diff again, after the index changed. */
  refreshAll(): Promise<void>;
  /** Hears of hunks staged or unstaged from a diff. Returns the function that stops. */
  onIndexChanged(listener: () => void): () => void;
}

/** What the service asks of the editor plugin. */
export interface ChangesEditor {
  bufferAt(path: string): { id: number } | null;
  reloadDocument(documentId: number): Promise<void>;
}

/** The edit the view is asking to confirm. */
export interface PendingDiscard {
  entries: ChangeEntry[];
}

export interface GitChangesDeps {
  diffs: ChangesDiffs;
  editor: ChangesEditor;
  diffHost: Pick<DiffHost, "discard">;
  /** Hears of changes to files on disk. Returns the function that stops. */
  onFilesChanged: (handler: () => void) => () => void;
}

export class GitChangesService extends Service {
  private groups: ChangeGroups = { staged: [], unstaged: [] };
  private commitMessage = "";
  private pendingDiscard: PendingDiscard | null = null;
  private noticeText = "";
  private openedEntryKey: string | null = null;
  private busyNow = false;
  private requests = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  constructor(
    ctx: Context,
    private deps: GitChangesDeps,
  ) {
    super(ctx, "gitChanges");
    ctx.effect(() => deps.onFilesChanged(() => this.scheduleRefresh()), "gitChanges.files");
    ctx.effect(() => deps.diffs.onIndexChanged(() => void this.refresh()), "gitChanges.index");
    ctx.effect(() => this.ctx.workspace.onSelectionChange(() => void this.refresh()), "gitChanges.worktree");
    ctx.effect(() => () => clearTimeout(this.refreshTimer), "gitChanges.timer");
  }

  /** The staged and unstaged files. Reactive. */
  files(): ChangeGroups {
    this.changes.track();
    return this.groups;
  }

  /** The commit message being written. Reactive. */
  message(): string {
    this.changes.track();
    return this.commitMessage;
  }

  /** Records the commit message as typed. */
  setMessage(text: string): void {
    this.commitMessage = text;
    this.changes.notify();
  }

  /** Whether a commit would go through: something is staged and there is a message. Reactive. */
  canCommit(): boolean {
    this.changes.track();
    return this.groups.staged.length > 0 && this.commitMessage.trim() !== "" && !this.busyNow;
  }

  /** Whether an action is running, so a second one waits. Reactive. */
  busy(): boolean {
    this.changes.track();
    return this.busyNow;
  }

  /** The key of the entry whose diff was opened last, which the view marks. Reactive. */
  openedKey(): string | null {
    this.changes.track();
    return this.openedEntryKey;
  }

  /** The discard waiting for a confirmation, or null. Reactive. */
  pending(): PendingDiscard | null {
    this.changes.track();
    return this.pendingDiscard;
  }

  /** What went wrong with the last action, or an empty string. Reactive. */
  notice(): string {
    this.changes.track();
    return this.noticeText;
  }

  /** Dismisses the notice. */
  clearNotice(): void {
    this.noticeText = "";
    this.changes.notify();
  }

  /** Reads the shown worktree's changed files. With no worktree shown, there are none. */
  async refresh(): Promise<void> {
    const worktree = this.ctx.workspace.selectedWorktree();
    if (worktree === null || !this.ctx.sidecar.isRunning()) {
      this.groups = { staged: [], unstaged: [] };
      this.changes.notify();
      return;
    }
    this.requests += 1;
    const request = this.requests;
    let files: DiffFile[];
    try {
      files = await this.ctx.sidecar.workbench.git.changedFiles(worktree.id);
    } catch (error) {
      this.noticeText = describeError(error);
      this.changes.notify();
      return;
    }
    if (request !== this.requests) {
      return;
    }
    this.groups = groupChanges(files);
    this.changes.notify();
  }

  /** Stages files. */
  async stage(entries: ChangeEntry[]): Promise<void> {
    await this.act((worktreeId) => this.ctx.sidecar.workbench.git.stage(worktreeId, pathsOf(entries)));
  }

  /** Takes files out of the index, keeping their changes in the working tree. */
  async unstage(entries: ChangeEntry[]): Promise<void> {
    await this.act((worktreeId) => this.ctx.sidecar.workbench.git.unstage(worktreeId, pathsOf(entries)));
  }

  /** Stages every changed file. */
  stageAll(): Promise<void> {
    return this.stage(this.groups.unstaged);
  }

  /** Unstages every staged file. */
  unstageAll(): Promise<void> {
    return this.unstage(this.groups.staged);
  }

  /** Starts asking whether to throw files' changes away. */
  beginDiscard(entries: ChangeEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.pendingDiscard = { entries };
    this.changes.notify();
  }

  /** Drops the discard being asked about. */
  cancelDiscard(): void {
    this.pendingDiscard = null;
    this.changes.notify();
  }

  /** Throws away the changes of the files being asked about: tracked ones go back to the index, untracked ones are deleted. */
  async confirmDiscard(): Promise<void> {
    const pending = this.pendingDiscard;
    this.pendingDiscard = null;
    this.changes.notify();
    const worktree = this.ctx.workspace.selectedWorktree();
    if (pending === null || worktree === null) {
      return;
    }
    const files = pending.entries.map((entry) => ({
      path: `${worktree.path}/${entry.path}`,
      untracked: entry.changeType === "untracked",
    }));
    await this.act(async () => {
      await this.deps.diffHost.discard(files);
      await this.reloadOpenFiles(files.map((file) => file.path));
    });
  }

  /** Commits what is staged with the message, and clears the message. */
  async commit(): Promise<boolean> {
    if (!this.canCommit()) {
      return false;
    }
    const message = this.commitMessage.trim();
    const ok = await this.act((worktreeId) => this.ctx.sidecar.workbench.git.commit(worktreeId, message));
    if (ok) {
      this.commitMessage = "";
      this.changes.notify();
    }
    return ok;
  }

  /** Shows a file's changes over the file in an editor: against the index when unstaged, against HEAD when staged. */
  async open(entry: ChangeEntry): Promise<void> {
    const worktree = this.ctx.workspace.selectedWorktree();
    if (worktree === null) {
      return;
    }
    this.openedEntryKey = entry.key;
    this.changes.notify();
    await this.deps.diffs.showInEditor(`${worktree.path}/${entry.path}`, diffBaseOf(entry));
  }

  /** Runs an action in the shown worktree, then reads the changes and the open diffs again. Resolves to whether it worked. */
  private async act(action: (worktreeId: string) => Promise<unknown>): Promise<boolean> {
    const worktree = this.ctx.workspace.selectedWorktree();
    if (worktree === null || this.busyNow) {
      return false;
    }
    this.busyNow = true;
    this.noticeText = "";
    this.changes.notify();
    let ok = true;
    try {
      await action(worktree.id);
    } catch (error) {
      this.noticeText = describeError(error);
      ok = false;
    }
    this.busyNow = false;
    await this.refresh();
    await this.deps.diffs.refreshAll();
    return ok;
  }

  /** Reads the files that are open in an editor again, since git changed them on disk. */
  private async reloadOpenFiles(paths: string[]): Promise<void> {
    for (const path of paths) {
      const buffer = this.deps.editor.bufferAt(path);
      if (buffer !== null) {
        await this.deps.editor.reloadDocument(buffer.id);
      }
    }
  }

  /** Gathers a burst of file system events into one read. */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }
}

/** The paths of entries, each once. */
function pathsOf(entries: ChangeEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.path))];
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
