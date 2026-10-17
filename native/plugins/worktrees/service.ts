// The `worktrees` service: what the worktrees view shows beside the workspace's own list of
// worktrees. That is how far each branch is from the base and how many lines each worktree
// changes, both read from the sidecar, plus the create and remove edits the view offers. It
// reads again when the watcher reports a change in the shown worktree, so a dirty marker
// follows the files.

import { Service, type Context } from "@neoworks/extension-system";
import type { BranchPosition, DiffStats, WorkbenchConfig, Worktree } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

declare module "@neoworks/extension-system" {
  interface Context {
    worktrees: WorktreesService;
  }
}

/** How long file system events are gathered before the worktrees are read again. */
const REFRESH_DELAY_MS = 400;

/** The edit the view is asking about. */
export interface PendingWorktreeAction {
  kind: "create" | "remove";
  /** The worktree to remove. */
  worktree?: Worktree;
}

export class WorktreesService extends Service {
  private positions: Record<string, BranchPosition> = {};
  private stats: Record<string, DiffStats> = {};
  private pendingAction: PendingWorktreeAction | null = null;
  private noticeText: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "worktrees");
    ctx.sidecar.on("event:fs-change", () => this.scheduleRefresh());
    ctx.effect(() => () => clearTimeout(this.refreshTimer), "worktrees refresh timer");
  }

  /** How far a worktree's branch is from the base, or undefined when unknown. Reactive. */
  positionOf(worktreeId: string): BranchPosition | undefined {
    this.changes.track();
    return this.positions[worktreeId];
  }

  /** The lines a worktree changes against HEAD, or undefined when unknown. Reactive. */
  statsOf(worktreeId: string): DiffStats | undefined {
    this.changes.track();
    return this.stats[worktreeId];
  }

  /** The edit waiting for a name or a confirmation, or null. Reactive. */
  pending(): PendingWorktreeAction | null {
    this.changes.track();
    return this.pendingAction;
  }

  /** What went wrong with the last edit, or null. Reactive. */
  notice(): string | null {
    this.changes.track();
    return this.noticeText;
  }

  /** Dismisses the notice of a failed edit. */
  clearNotice(): void {
    this.noticeText = null;
    this.changes.notify();
  }

  /** Reads the worktrees, their positions against the base, and their line counts. */
  async refresh(): Promise<void> {
    const workspace = this.ctx.workspace;
    try {
      await workspace.refreshWorktrees();
    } catch {
      return;
    }
    await Promise.all([this.loadPositions(), this.loadStats(workspace.worktrees())]);
    this.changes.notify();
  }

  /** Starts asking for the name of a new worktree. */
  beginCreate(): void {
    this.pendingAction = { kind: "create" };
    this.changes.notify();
  }

  /** Starts asking whether to remove a worktree. */
  beginRemove(worktree: Worktree): void {
    this.pendingAction = { kind: "remove", worktree };
    this.changes.notify();
  }

  /** Drops the waiting edit. */
  cancelPending(): void {
    this.pendingAction = null;
    this.changes.notify();
  }

  /**
   * Creates a worktree on a new branch of the same name, off the repository's default base
   * branch, and shows it. Resolves to whether it was created.
   */
  async commitCreate(name: string): Promise<boolean> {
    const trimmed = name.trim();
    this.pendingAction = null;
    this.noticeText = null;
    this.changes.notify();
    if (trimmed === "") {
      return false;
    }
    try {
      const baseBranch = await this.defaultBaseBranch();
      const created = await this.ctx.sidecar.workbench.worktrees.create({ name: trimmed, baseBranch, newBranch: trimmed });
      await this.refresh();
      await this.ctx.workspace.selectWorktree(created.id);
      return true;
    } catch (error) {
      this.noticeText = describeError(error);
      this.changes.notify();
      return false;
    }
  }

  /** Removes the worktree being asked about, keeping its branch. Resolves to whether it went. */
  async confirmRemove(): Promise<boolean> {
    const action = this.pendingAction;
    this.pendingAction = null;
    this.noticeText = null;
    this.changes.notify();
    if (action === null || action.worktree === undefined) {
      return false;
    }
    const removed = action.worktree;
    try {
      const remaining = await this.ctx.sidecar.workbench.worktrees.remove(removed.id, removed.dirty);
      this.ctx.workspace.replaceWorktrees(remaining);
      await this.refresh();
      return true;
    } catch (error) {
      this.noticeText = describeError(error);
      this.changes.notify();
      return false;
    }
  }

  /** The branch new worktrees start from, falling back to `main` when the config cannot be read. */
  private async defaultBaseBranch(): Promise<string> {
    try {
      const config: WorkbenchConfig = await this.ctx.sidecar.workbench.config.load();
      return config.workbench.default_base_branch;
    } catch {
      return "main";
    }
  }

  private async loadPositions(): Promise<void> {
    try {
      this.positions = await this.ctx.sidecar.workbench.worktrees.positions();
    } catch {
      this.positions = {};
    }
  }

  private async loadStats(worktrees: Worktree[]): Promise<void> {
    const next: Record<string, DiffStats> = {};
    for (const worktree of worktrees) {
      try {
        next[worktree.id] = await this.ctx.sidecar.workbench.git.diffStats(worktree.id);
      } catch {
        // A worktree whose stats cannot be read shows none.
      }
    }
    this.stats = next;
  }

  /** Gathers a burst of file system events into one refresh. */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
