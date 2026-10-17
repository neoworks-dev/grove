// The `workspace` service: the repository that is open, its worktrees and the one the views
// show. The repository is opened through the sidecar's `repo:open`, remembered by the sidecar,
// and reopened at the next start. Opening one also makes its `.grove/profile.json` the
// project layer of the profile. Plugins read it reactively, and it reads as "nothing open"
// whenever the sidecar cannot answer.

import { Service, type Context } from "@neoworks/extension-system";
import type { RepoInfo, Worktree } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

declare module "@neoworks/extension-system" {
  interface Context {
    workspace: WorkspaceService;
  }
}

/** What `repo:open` answers with. */
interface OpenedRepo {
  info: RepoInfo;
  worktrees: Worktree[];
}

/** The repository's state in the sidecar's per-repo store that the workspace keeps. */
interface RepoState {
  selectedWorktreeId?: string | null;
}

export type WorkspaceState = "none" | "opening" | "open";

export class WorkspaceService extends Service {
  private repoInfo: RepoInfo | null = null;
  private worktreeList: Worktree[] = [];
  private selectedId: string | null = null;
  private currentState: WorkspaceState = "none";
  private failure: string | null = null;
  private changes: ChangeSignal = createChangeSignal();
  private selectionListeners = new Set<(worktree: Worktree | null) => void>();
  /** The directory of the worktree the listeners were last told about. */
  private announcedPath: string | null = null;

  constructor(ctx: Context) {
    super(ctx, "workspace");
    ctx.sidecar.on("event:worktrees-changed", (payload) => this.replaceWorktrees(payload as Worktree[]));
  }

  /** The open repository, or null. Reactive. */
  repo(): RepoInfo | null {
    this.changes.track();
    return this.repoInfo;
  }

  /** The repository's worktrees, main one first. Reactive. */
  worktrees(): Worktree[] {
    this.changes.track();
    return this.worktreeList;
  }

  /** The worktree the views show, or null while no repository is open. Reactive. */
  selectedWorktree(): Worktree | null {
    this.changes.track();
    const found = this.worktreeList.find((worktree) => worktree.id === this.selectedId);
    if (!found) {
      return null;
    }
    return found;
  }

  /**
   * Calls `listener` whenever the selected worktree becomes another one, or none, for plain
   * code that cannot read the reactive accessors. Stops with the calling plugin, or when the
   * returned function is called.
   */
  onSelectionChange(listener: (worktree: Worktree | null) => void): () => void {
    return this.ctx.effect(() => {
      this.selectionListeners.add(listener);
      return () => {
        this.selectionListeners.delete(listener);
      };
    }, "workspace.onSelectionChange");
  }

  /** The branch checked out in the selected worktree, or null. Reactive. */
  branch(): string | null {
    const selected = this.selectedWorktree();
    if (selected) {
      return selected.branch;
    }
    if (this.repoInfo) {
      return this.repoInfo.currentBranch;
    }
    return null;
  }

  /** Whether a repository is being opened, is open, or neither. Reactive. */
  state(): WorkspaceState {
    this.changes.track();
    return this.currentState;
  }

  /** Why the last open failed, or null. Reactive. */
  error(): string | null {
    this.changes.track();
    return this.failure;
  }

  /**
   * Opens the repository at a path. Resolves to whether it opened; a path that is not a
   * repository, or a sidecar that is down, leaves the current repository open and sets `error()`.
   */
  async open(path: string): Promise<boolean> {
    const previousState = this.currentState;
    this.currentState = "opening";
    this.changes.notify();
    try {
      const opened = await this.ctx.sidecar.call<OpenedRepo>("repo:open", path);
      await this.adopt(opened);
      return true;
    } catch (error) {
      this.failure = describeError(error);
      this.currentState = previousState;
      this.changes.notify();
      this.ctx.logger.warn(`could not open ${path}: ${this.failure}`);
      return false;
    }
  }

  /**
   * Opens the repository the app starts on: `explicitPath` when it is not empty, else the one
   * the sidecar remembers from last time. Resolves to whether one opened.
   */
  async restore(explicitPath: string): Promise<boolean> {
    if (explicitPath !== "") {
      return this.open(explicitPath);
    }
    let last: string | null = null;
    try {
      last = await this.ctx.sidecar.call<string | null>("repo:last");
    } catch (error) {
      this.ctx.logger.warn(`could not read the last repository: ${describeError(error)}`);
      return false;
    }
    if (last === null) {
      return false;
    }
    return this.open(last);
  }

  /** Makes a worktree the one the views show, and has the sidecar watch it. */
  async selectWorktree(worktreeId: string): Promise<void> {
    if (!this.worktreeList.some((worktree) => worktree.id === worktreeId)) {
      return;
    }
    this.selectedId = worktreeId;
    this.changes.notify();
    this.announceSelection();
    await this.afterSelection();
  }

  /** Reads the repository's worktrees again, such as after one was created or removed. */
  async refreshWorktrees(): Promise<void> {
    const list = await this.ctx.sidecar.call<Worktree[]>("worktrees:list");
    this.replaceWorktrees(list);
  }

  /** Takes an opened repository as the workspace: its worktrees, the selected one, and its profile. */
  private async adopt(opened: OpenedRepo): Promise<void> {
    this.repoInfo = opened.info;
    this.worktreeList = opened.worktrees;
    this.failure = null;
    this.currentState = "open";
    this.selectedId = await this.rememberedSelection(opened);
    this.changes.notify();
    this.announceSelection();
    await this.afterSelection();
    await this.ctx.profile.setProjectFolder(opened.info.path);
  }

  /** The worktree the repository was last left on, else the one at the repository's own path, else the first. */
  private async rememberedSelection(opened: OpenedRepo): Promise<string | null> {
    let remembered: string | null | undefined;
    try {
      const repoState = await this.ctx.sidecar.call<RepoState>("state:getRepo");
      remembered = repoState.selectedWorktreeId;
    } catch {
      remembered = null;
    }
    if (remembered && opened.worktrees.some((worktree) => worktree.id === remembered)) {
      return remembered;
    }
    const atRoot = opened.worktrees.find((worktree) => worktree.path === opened.info.path);
    if (atRoot) {
      return atRoot.id;
    }
    if (opened.worktrees.length > 0) {
      return opened.worktrees[0].id;
    }
    return null;
  }

  /** Tells the sidecar which worktree to watch and remember. Failing to is not worth interrupting for. */
  private async afterSelection(): Promise<void> {
    if (this.selectedId === null) {
      return;
    }
    try {
      await this.ctx.sidecar.call("fs:watch", [this.selectedId]);
      await this.ctx.sidecar.call("state:update", { selectedWorktreeId: this.selectedId });
    } catch (error) {
      this.ctx.logger.warn(`could not watch the worktree: ${describeError(error)}`);
    }
  }

  /** Takes a new list of worktrees, moving the selection off one that is gone. */
  replaceWorktrees(list: Worktree[]): void {
    this.worktreeList = list;
    if (!list.some((worktree) => worktree.id === this.selectedId)) {
      this.selectedId = null;
      if (list.length > 0) {
        this.selectedId = list[0].id;
      }
    }
    this.changes.notify();
    this.announceSelection();
  }

  /** Tells the selection listeners when the selected worktree is another directory than they last heard of. */
  private announceSelection(): void {
    const selected = this.selectedWorktree();
    let path: string | null = null;
    if (selected !== null) {
      path = selected.path;
    }
    if (path === this.announcedPath) {
      return;
    }
    this.announcedPath = path;
    for (const listener of [...this.selectionListeners]) {
      listener(selected);
    }
  }
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
