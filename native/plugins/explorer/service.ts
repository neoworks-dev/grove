// The `explorer` service: the file tree of the worktree the workspace shows. It lists
// directories lazily through the sidecar's `files:listDir`, marks files git has changed from
// `git:changedFiles`, and follows the watcher's `event:fs-change` so a file made outside the
// app shows up. It also carries out the edits the context menu offers: create, rename and
// delete, each as a pending action the view asks the name or the confirmation for.

import { Service, type Context } from "@neoworks/extension-system";
import type { DiffChangeType, DiffFile, FileNode } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import { ExplorerModel, joinPath, parentOf, type FileSystemChange } from "./model";

declare module "@neoworks/extension-system" {
  interface Context {
    explorer: ExplorerService;
  }
}

/** How long file system events are gathered before the tree reads again. */
const REFRESH_DELAY_MS = 120;

export type ExplorerStatus = "ready" | "loading" | "no-folder" | "sidecar-down" | "failed";

/** An edit waiting for the user's name or confirmation. */
export interface PendingAction {
  kind: "create-file" | "create-directory" | "rename" | "delete";
  /** The directory a new entry goes in. */
  directory: string;
  /** The path being renamed or deleted. */
  target: string;
  /** The text a name field starts with. */
  initialName: string;
}

export interface ExplorerOptions {
  /** Shows a file in the editor. */
  openInEditor(absolutePath: string): void;
}

export class ExplorerService extends Service {
  readonly model = new ExplorerModel();
  private options: ExplorerOptions;
  private worktreeId: string | null = null;
  private loading = false;
  /** Why the root could not be listed. */
  private failure: string | null = null;
  /** What went wrong with the last edit, kept until it is dismissed. */
  private noticeText: string | null = null;
  private pendingAction: PendingAction | null = null;
  /** The path, relative to the worktree, that the view is to expand to and select. */
  private revealing: string | null = null;
  private staleDirectories = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, options: ExplorerOptions) {
    super(ctx, "explorer");
    this.options = options;
    ctx.sidecar.on("event:fs-change", (payload) => this.noteChange(payload as FileSystemChange));
    ctx.effect(() => () => clearTimeout(this.refreshTimer), "explorer refresh timer");
  }

  /** What the view should draw. Reactive. */
  status(): ExplorerStatus {
    this.changes.track();
    if (!this.ctx.sidecar.isRunning()) {
      return "sidecar-down";
    }
    if (this.ctx.workspace.selectedWorktree() === null) {
      return "no-folder";
    }
    if (this.failure !== null) {
      return "failed";
    }
    if (this.loading) {
      return "loading";
    }
    return "ready";
  }

  /** Why the listing failed, or null. Reactive. */
  error(): string | null {
    this.changes.track();
    return this.failure;
  }

  /** What went wrong with the last edit, or null. Reactive. */
  notice(): string | null {
    this.changes.track();
    return this.noticeText;
  }

  /** The top level of the tree. Reactive. */
  roots(): FileNode[] {
    this.changes.track();
    const listed = this.model.children("");
    if (listed === undefined) {
      return [];
    }
    return listed;
  }

  /** A folder's entries once it has been listed; undefined before. Reactive. */
  childrenOf(node: FileNode): FileNode[] | undefined {
    this.changes.track();
    return this.model.children(node.relPath);
  }

  /** The entry at a path, once its folder has been listed. */
  nodeAt(relPath: string): FileNode | undefined {
    const siblings = this.model.children(parentOf(relPath));
    if (siblings === undefined) {
      return undefined;
    }
    return siblings.find((node) => node.relPath === relPath);
  }

  /** The git change of a path. Reactive. */
  changeOf(relPath: string): DiffChangeType | undefined {
    this.changes.track();
    return this.model.changeOf(relPath);
  }

  /** The folders that carry a change marker given what is expanded. Reactive. */
  markedDirectories(expanded: ReadonlySet<string | number>): Set<string> {
    this.changes.track();
    return this.model.markedDirectories(expanded);
  }

  /** The edit waiting for a name or a confirmation, or null. Reactive. */
  pending(): PendingAction | null {
    this.changes.track();
    return this.pendingAction;
  }

  /**
   * Shows a worktree's tree. Another worktree than the one shown starts from nothing; the
   * same one is read again.
   */
  async show(worktreeId: string): Promise<void> {
    if (worktreeId !== this.worktreeId) {
      this.worktreeId = worktreeId;
      this.model.reset();
      this.pendingAction = null;
      this.failure = null;
      this.noticeText = null;
    }
    this.loading = !this.model.hasDirectory("");
    this.changes.notify();
    await Promise.all([this.loadDirectory(""), this.loadGitChanges(worktreeId)]);
    this.loading = false;
    this.changes.notify();
  }

  /** Asks the view to expand the tree down to a path and select it. */
  requestReveal(relPath: string): void {
    this.revealing = relPath;
    this.changes.notify();
  }

  /** The path waiting to be expanded to and selected, or null. Reactive. */
  pendingReveal(): string | null {
    this.changes.track();
    return this.revealing;
  }

  /** Marks a reveal as done, so it is not made again. */
  finishReveal(relPath: string): void {
    if (this.revealing === relPath) {
      this.revealing = null;
    }
  }

  /** Lists a directory unless it already has been. */
  async ensureLoaded(relPath: string): Promise<void> {
    if (this.model.hasDirectory(relPath)) {
      return;
    }
    await this.loadDirectory(relPath);
  }

  /** Opens a file in the editor. */
  openFile(node: FileNode): void {
    this.options.openInEditor(node.path);
  }

  /** Starts creating an entry in a directory. */
  beginCreate(kind: "create-file" | "create-directory", directory: string): void {
    this.pendingAction = { kind, directory, target: "", initialName: "" };
    this.changes.notify();
  }

  /** Starts renaming an entry. */
  beginRename(node: FileNode): void {
    this.pendingAction = { kind: "rename", directory: parentOf(node.relPath), target: node.relPath, initialName: node.name };
    this.changes.notify();
  }

  /** Starts deleting an entry, which waits for confirmation. */
  beginDelete(node: FileNode): void {
    this.pendingAction = { kind: "delete", directory: parentOf(node.relPath), target: node.relPath, initialName: node.name };
    this.changes.notify();
  }

  /** Drops the waiting edit. */
  cancelPending(): void {
    this.pendingAction = null;
    this.changes.notify();
  }

  /**
   * Carries out the waiting edit, with the name the user typed for a create or rename.
   * Resolves to the path that now exists, so the view can show it, or null when nothing
   * was done. A failure is kept as the notice.
   */
  async commitPending(name: string): Promise<string | null> {
    const action = this.pendingAction;
    const worktreeId = this.worktreeId;
    this.pendingAction = null;
    this.noticeText = null;
    this.changes.notify();
    if (action === null || worktreeId === null) {
      return null;
    }
    try {
      return await this.carryOut(worktreeId, action, name.trim());
    } catch (error) {
      this.noticeText = describeError(error);
      this.changes.notify();
      return null;
    }
  }

  /** Dismisses the notice of a failed edit. */
  clearNotice(): void {
    this.noticeText = null;
    this.changes.notify();
  }

  /** Reads the root, the directories listed so far and the git changes again. */
  async refresh(): Promise<void> {
    if (this.worktreeId === null) {
      return;
    }
    await this.reloadLoaded();
    await this.loadGitChanges(this.worktreeId);
  }

  /** Does what a pending action asks, after checking the name. */
  private async carryOut(worktreeId: string, action: PendingAction, name: string): Promise<string | null> {
    const sidecar = this.ctx.sidecar;
    if (action.kind === "delete") {
      await sidecar.workbench.files.delete(worktreeId, action.target);
      await this.reloadAfterEdit(action.directory);
      return null;
    }
    if (name === "") {
      return null;
    }
    const destination = joinPath(action.directory, name);
    if (action.kind === "rename") {
      await sidecar.workbench.files.rename(worktreeId, action.target, destination);
    } else if (action.kind === "create-directory") {
      await sidecar.workbench.files.createDir(worktreeId, destination);
    } else {
      await sidecar.workbench.files.create(worktreeId, destination);
    }
    await this.reloadAfterEdit(action.directory);
    return destination;
  }

  /** Reads the edited directory and the git changes, so the tree is right before the watcher reports. */
  private async reloadAfterEdit(directory: string): Promise<void> {
    await this.loadDirectory(directory);
    if (this.worktreeId !== null) {
      await this.loadGitChanges(this.worktreeId);
    }
  }

  /** Lists one directory into the model; a directory that is gone is dropped quietly. */
  private async loadDirectory(relPath: string): Promise<void> {
    const worktreeId = this.worktreeId;
    if (worktreeId === null) {
      return;
    }
    try {
      const nodes = await this.ctx.sidecar.workbench.files.listDir(worktreeId, relPath);
      if (worktreeId !== this.worktreeId) {
        return;
      }
      this.model.setDirectory(relPath, nodes);
      this.failure = null;
    } catch (error) {
      this.handleListingFailure(relPath, error);
    }
    this.changes.notify();
  }

  /** A directory deleted under the tree is forgotten; any other failure is shown, as the error for the root. */
  private handleListingFailure(relPath: string, error: unknown): void {
    const message = describeError(error);
    if (message.includes("ENOENT") || message.includes("ENOTDIR")) {
      this.model.forgetDirectory(relPath);
      return;
    }
    if (relPath === "") {
      this.failure = message;
      return;
    }
    this.noticeText = message;
  }

  /** Reads which files git sees as changed. Not being able to is not worth showing. */
  private async loadGitChanges(worktreeId: string): Promise<void> {
    try {
      const changed: DiffFile[] = await this.ctx.sidecar.workbench.git.changedFiles(worktreeId);
      if (worktreeId !== this.worktreeId) {
        return;
      }
      this.model.setChanges(changed);
    } catch {
      this.model.setChanges([]);
    }
    this.changes.notify();
  }

  /** Notes a file system change in the shown worktree and schedules one read for a burst of them. */
  private noteChange(change: FileSystemChange): void {
    if (change.worktreeId !== this.worktreeId) {
      return;
    }
    for (const directory of this.model.staleDirectories(change)) {
      this.staleDirectories.add(directory);
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.flushChanges(), REFRESH_DELAY_MS);
  }

  /** Reads what the gathered changes made stale. */
  private async flushChanges(): Promise<void> {
    const directories = [...this.staleDirectories];
    this.staleDirectories.clear();
    await Promise.all(directories.map((directory) => this.loadDirectory(directory)));
    if (this.worktreeId !== null) {
      await this.loadGitChanges(this.worktreeId);
    }
    this.changes.notify();
  }

  /** Lists every directory the model holds again. */
  private async reloadLoaded(): Promise<void> {
    const directories = new Set(["", ...this.model.loadedDirectories()]);
    await Promise.all([...directories].map((directory) => this.loadDirectory(directory)));
  }
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
