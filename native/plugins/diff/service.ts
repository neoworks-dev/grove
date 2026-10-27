// The `diff` service: diffs as tabs of an ordinary editor pane (see `inline.ts`), and the hunk
// actions that work on the editor's cursor.
//
// A diff tab is the pane's one editor over the new text, with the difference drawn as decorations
// by the host (see `src/diff.rs`): inline, the removed lines as blocks between the new ones; or
// side by side, a document of the old text drawn left of the new by the same editor, with fillers
// so the rows of a hunk line up. A file's diff shows the file's own document, so it can be edited
// and saved as in its own tab. State is plain fields with a change signal, never `$state`.
//
// Other plugins open a diff tab with `ctx.diff.showInEditor(path, base)`, or of two texts with
// `ctx.diff.showTextsInEditor(...)`.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { DocumentEvent, EditorService } from "../editor/service";
import type { DiffHost, GitBase } from "./diffHost";
import { InlineDiffs, type DiffTab, type InlineEntry, type InlineView } from "./inline";
import { hunkAtRow, stepHunkRow, type DiffBase, type DiffMode, type Hunk } from "./model";

export { baseLabel, hunkPosition, stepHunkRow } from "./model";
export type { DiffBase, DiffMode, Hunk } from "./model";
export type { DiffTab, InlineEntry, InlineView } from "./inline";

declare module "@neoworks/extension-system" {
  interface Context {
    diff: DiffService;
  }
}

/** The decoration source the normal editor's hunk preview draws under. */
export const PREVIEW_SOURCE = "git.preview";

/** How long file system events are gathered before the git side of the diffs is read again. */
const FILES_CHANGED_DELAY_MS = 400;

/** What the service needs from the layout. */
export interface DiffPanes {
  readonly focusedLeafId: string;
  onPaneClosed(listener: (leafId: string) => void): () => void;
}

export interface DiffOptions {
  /** Hears of changes to files on disk. Returns the function that stops. */
  onFilesChanged?: (handler: () => void) => () => void;
}

/** The diff tab the focused pane shows, with its document. */
interface FocusedDiff extends InlineView {
  documentId: number;
}

export class DiffService extends Service {
  private noticeText = "";
  private changes: ChangeSignal = createChangeSignal();
  private filesTimer: ReturnType<typeof setTimeout> | undefined;
  /** The documents that show a hunk preview, with the rows of the hunk. */
  private previews = new Map<number, Hunk>();
  /** The mode a diff opens in. */
  private defaultMode: DiffMode = "inline";
  private indexListeners = new Set<() => void>();
  /** The diff tabs of the editor panes. */
  private inline: InlineDiffs;
  private inlineListeners = new Set<() => void>();

  constructor(
    ctx: Context,
    private editor: EditorService,
    private panes: DiffPanes,
    private host: DiffHost,
    options: DiffOptions = {},
  ) {
    super(ctx, "diff");
    this.inline = new InlineDiffs(editor, host, {
      mode: () => this.defaultMode,
      changed: () => {
        this.changes.notify();
        for (const listener of [...this.inlineListeners]) {
          listener();
        }
      },
      say: (text) => this.say(text),
      warn: (message) => ctx.logger.warn(message),
    });
    ctx.effect(() => editor.onDocumentEvent((event) => this.handleDocumentEvent(event)), "diff.documents");
    ctx.effect(
      () => editor.onDiffTabClosed((leafId, documentId) => this.background(this.inline.hide(leafId, documentId), "closing a diff")),
      "diff.tabs",
    );
    ctx.effect(() => panes.onPaneClosed((leafId) => this.inline.onPaneClosed(leafId)), "diff.paneClosed");
    if (options.onFilesChanged) {
      const onFilesChanged = options.onFilesChanged;
      ctx.effect(() => onFilesChanged(() => this.scheduleFilesChanged()), "diff.files");
    }
    ctx.effect(() => () => this.cancelTimers(), "diff.timers");
  }

  /**
   * Shows how a file differs from a base in a diff tab of an editor pane, HEAD by default.
   * Resolves to whether it could be shown.
   */
  async showInEditor(path: string, base: DiffBase = "head"): Promise<boolean> {
    return this.inline.show(path, base);
  }

  /** Shows how two texts differ in a diff tab. `name`'s extension says what language they are. Resolves to the tab, or null. */
  showTextsInEditor(name: string, oldText: string, newText: string, label = "Before"): Promise<DiffTab | null> {
    return this.inline.showTexts(name, oldText, newText, label);
  }

  /** Shows how two texts differ in a diff tab, and resolves to its pane, or null. */
  async openTexts(name: string, oldText: string, newText: string, label = "Before"): Promise<string | null> {
    const tab = await this.showTextsInEditor(name, oldText, newText, label);
    if (tab === null) {
      return null;
    }
    return tab.leafId;
  }

  /** From the focused pane's file, opens its diff against HEAD; from its diff tab, goes back to the file. */
  async toggleInEditor(): Promise<void> {
    const leafId = this.panes.focusedLeafId;
    const active = this.editor.activeTabIn(leafId);
    if (active !== null && active.kind === "diff") {
      await this.closeDiffTab({ leafId, documentId: active.id });
      this.editor.select(leafId, active.id);
      return;
    }
    if (active === null || active.path === "") {
      this.say("Open a file to see its changes.");
      return;
    }
    await this.inline.show(active.path, "head");
  }

  /** Closes the focused pane's diff tab, when that is the tab it shows. */
  async hideInEditor(): Promise<void> {
    const leafId = this.panes.focusedLeafId;
    const active = this.editor.activeTabIn(leafId);
    if (active !== null && active.kind === "diff") {
      await this.closeDiffTab({ leafId, documentId: active.id });
    }
  }

  /** Closes every diff tab of a file. */
  async hideFromFile(path: string): Promise<void> {
    const shown = this.inline.entries().filter((entry) => entry.path === path);
    for (const entry of shown) {
      await this.closeDiffTab(entry);
    }
  }

  /** Closes a diff tab, which takes its diff away; a document that has no other tab closes with it. */
  async closeDiffTab(tab: DiffTab): Promise<void> {
    await this.editor.closeTab(tab.leafId, tab.documentId, "diff");
  }

  /** Every diff tab, with the file it is of and the changes found. Reactive. */
  inlineViews(): InlineEntry[] {
    this.changes.track();
    return this.inline.entries();
  }

  /** Hears when a diff tab appears, goes or is worked out again. Returns the function that stops it. */
  onInlineChanged(listener: () => void): () => void {
    this.inlineListeners.add(listener);
    return () => {
      this.inlineListeners.delete(listener);
    };
  }

  /** Tells the person something in the status bar, as the diff's own actions do. */
  tell(text: string): void {
    this.say(text);
  }

  /** The diff an editor pane shows of a document, or undefined unless the pane shows that document's diff tab. Reactive. */
  inlineView(leafId: string, documentId: number): InlineView | undefined {
    this.changes.track();
    const active = this.editor.activeTabIn(leafId);
    if (active === null || active.kind !== "diff" || active.id !== documentId) {
      return undefined;
    }
    return this.inline.viewOf(leafId, documentId);
  }

  /** The last thing worth telling the person, such as a hunk that could not be staged. Reactive. */
  notice(): string {
    this.changes.track();
    return this.noticeText;
  }

  /** Dismisses the notice. */
  clearNotice(): void {
    this.noticeText = "";
    this.changes.notify();
  }

  /** Hears of hunks that were staged or unstaged, which the file system watcher does not see. Returns the function that stops. */
  onIndexChanged(listener: () => void): () => void {
    this.indexListeners.add(listener);
    return () => {
      this.indexListeners.delete(listener);
    };
  }

  /** Reads the git side of every open diff again, such as after a commit. */
  async refreshAll(): Promise<void> {
    await this.inline.reloadAll();
  }

  /** The mode diffs open in. Reactive. */
  mode(): DiffMode {
    this.changes.track();
    return this.defaultMode;
  }

  /** Sets the mode a new diff opens in, as the settings say. */
  configure(mode: DiffMode): void {
    this.defaultMode = mode;
    this.changes.notify();
  }

  /** Switches a pane's diff tab, the focused pane's by default, between inline and side by side. */
  async toggleMode(leafId: string = this.panes.focusedLeafId): Promise<void> {
    const active = this.editor.activeTabIn(leafId);
    if (active === null || active.kind !== "diff") {
      return;
    }
    const shown = this.inline.viewOf(leafId, active.id);
    if (shown !== undefined) {
      await this.inline.setMode(leafId, active.id, otherMode(shown.mode));
    }
  }

  /** Whether the focused pane shows a diff tab. Reactive. */
  hasFocusedDiffTab(): boolean {
    this.changes.track();
    return this.focusedDiff() !== null;
  }

  /** Whether the focused pane shows a diff tab of staged changes, whose hunks can be unstaged. Reactive. */
  hasFocusedStagedDiff(): boolean {
    this.changes.track();
    const shown = this.focusedDiff();
    return shown !== null && shown.staged;
  }

  /** Moves the cursor to the next (1) or previous (-1) change, of the focused diff tab or else of the file against HEAD. */
  async stepChange(step: 1 | -1): Promise<void> {
    const shown = this.focusedDiff();
    if (shown !== null) {
      await this.attempt(() => this.moveToChange(shown.hunks, shown.documentId, step));
      return;
    }
    const active = this.editor.active();
    if (active === null || active.path === "") {
      return;
    }
    await this.attempt(async () => {
      const base = await this.host.baseText(active.path, "head");
      const hunks = await this.host.hunks(active.id, base.text);
      await this.moveToChange(hunks, active.id, step);
    });
  }

  /** Stages the hunk under the cursor of the focused editor, in its file's tab or diff tab. */
  async stageHunk(): Promise<void> {
    const shown = this.focusedDiff();
    if (shown !== null && shown.staged) {
      this.say("These changes are staged already.");
      return;
    }
    if (shown !== null && shown.gitBase === null) {
      this.say("Only a diff of a file against HEAD or the index can be staged.");
      return;
    }
    const active = this.editor.active();
    if (active === null || active.path === "") {
      this.say("Open a file to stage its changes.");
      return;
    }
    const row = this.rowOf(active.id);
    const ok = await this.attempt(() => this.host.stageHunk(active.id, row), "Staged the hunk.");
    if (ok) {
      await this.indexChanged();
    }
  }

  /** Takes the hunk under the cursor of the focused diff tab of staged changes out of the index. */
  async unstageHunk(): Promise<void> {
    const shown = this.focusedDiff();
    if (shown === null || !shown.staged) {
      this.say("Unstage works in a diff of the staged changes.");
      return;
    }
    const row = this.rowOf(shown.documentId);
    const ok = await this.attempt(() => this.host.unstageHunk(shown.path, row), "Unstaged the hunk.");
    if (ok) {
      await this.indexChanged();
    }
  }

  /** Puts back the old lines of the hunk under the cursor of the focused editor, as its diff tab's base or else HEAD has them. */
  async revertHunk(): Promise<void> {
    const shown = this.focusedDiff();
    if (shown !== null && shown.gitBase === null) {
      this.say("Only a diff of a file against HEAD or the index can be reverted.");
      return;
    }
    const active = this.editor.active();
    if (active === null || active.path === "") {
      this.say("Open a file to revert its changes.");
      return;
    }
    let base: GitBase = "head";
    if (shown !== null && shown.gitBase !== null) {
      base = shown.gitBase;
    }
    const row = this.rowOf(active.id);
    await this.attempt(() => this.host.revertHunk(active.id, base, row), "Reverted the hunk.");
  }

  /** Shows the old lines of the hunk under the editor's cursor above it, or hides them again. */
  async previewHunk(): Promise<void> {
    const active = this.editor.active();
    if (active === null || active.path === "") {
      this.say("Open a file to preview its changes.");
      return;
    }
    if (this.previews.has(active.id)) {
      await this.hidePreview(active.id);
      return;
    }
    await this.attempt(async () => {
      const base = await this.host.baseText(active.path, "head");
      const row = this.rowOf(active.id);
      const hunk = hunkAtRow(await this.host.hunks(active.id, base.text), row);
      if (hunk === null) {
        this.say("There is no change under the cursor.");
        return;
      }
      await this.host.preview(active.id, base.text, row, PREVIEW_SOURCE);
      this.previews.set(active.id, hunk);
    });
  }

  /** The diff tab the focused pane shows, or null when it shows something else. */
  private focusedDiff(): FocusedDiff | null {
    const leafId = this.panes.focusedLeafId;
    const active = this.editor.activeTabIn(leafId);
    if (active === null || active.kind !== "diff") {
      return null;
    }
    const shown = this.inline.viewOf(leafId, active.id);
    if (shown === undefined) {
      return null;
    }
    return { ...shown, documentId: active.id };
  }

  /** Moves the focused editor's cursor to the next or previous of these hunks, and scrolls it to the middle. */
  private async moveToChange(hunks: Hunk[], documentId: number, step: 1 | -1): Promise<void> {
    const row = stepHunkRow(hunks, this.rowOf(documentId), step);
    if (row === null) {
      this.say("There are no changes.");
      return;
    }
    await this.editor.applyToFocused({ type: "place_cursor", at: { row, column: 0 } });
    await this.editor.applyToFocused({ type: "scroll_to", align: "center" });
  }

  /** The row a document's cursor is on, the first until it has moved. */
  private rowOf(documentId: number): number {
    const cursor = this.editor.cursorOf(documentId);
    if (cursor === null) {
      return 0;
    }
    return cursor.row;
  }

  /** The index changed: open diffs read it again and the listeners hear of it. */
  private async indexChanged(): Promise<void> {
    for (const listener of [...this.indexListeners]) {
      listener();
    }
    await this.refreshAll();
  }

  /** Hides the hunk preview of a document. */
  private async hidePreview(documentId: number): Promise<void> {
    this.previews.delete(documentId);
    await this.editor.setDecorationsOf(documentId, PREVIEW_SOURCE, []);
  }

  /** Runs a host action, and says `done` when it worked or what went wrong when it did not. */
  private async attempt(action: () => Promise<unknown>, done = ""): Promise<boolean> {
    try {
      await action();
    } catch (error) {
      this.say(describeError(error));
      return false;
    }
    if (done !== "") {
      this.say(done);
    }
    return true;
  }

  /** Sets the notice. */
  private say(text: string): void {
    this.noticeText = text;
    this.changes.notify();
  }

  /** Reacts to something that happened to a document. */
  private handleDocumentEvent(event: DocumentEvent): void {
    if (event.type === "edited") {
      this.clearPreview(event.id);
      this.inline.onEdited(event.id);
      return;
    }
    if (event.type === "selections") {
      this.followPreviewCursor(event.id, event.row);
      return;
    }
    if (event.type === "change-request") {
      let step: 1 | -1 = -1;
      if (event.forward) {
        step = 1;
      }
      this.background(this.stepChange(step), "moving to a change");
      return;
    }
    if (event.type === "closed") {
      this.previews.delete(event.id);
      this.inline.onDocumentClosed(event.id);
    }
  }

  /** Drops a document's hunk preview, since the text it was drawn for changed. */
  private clearPreview(documentId: number): void {
    if (this.previews.has(documentId)) {
      this.background(this.hidePreview(documentId), "hiding a preview");
    }
  }

  /** Drops a hunk preview when the cursor leaves its hunk. */
  private followPreviewCursor(documentId: number, row: number): void {
    const hunk = this.previews.get(documentId);
    if (hunk !== undefined && !hunkAtRow([hunk], row)) {
      this.background(this.hidePreview(documentId), "hiding a preview");
    }
  }

  /** Gathers a burst of file system events into one read of the git side of the diffs. */
  private scheduleFilesChanged(): void {
    clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => this.background(this.inline.reloadAll(), "reading the changes again"), FILES_CHANGED_DELAY_MS);
  }

  /** Stops the timers that are pending. */
  private cancelTimers(): void {
    clearTimeout(this.filesTimer);
    this.inline.cancelTimers();
  }

  /** Runs work nobody waits for, and logs what it throws so that it never ends as an unhandled rejection. */
  private background(work: Promise<unknown>, what: string): void {
    work.catch((error) => this.ctx.logger.warn(`diff: ${what} failed: ${describeError(error)}`));
  }
}

/** Side by side for an inline diff, inline for a side-by-side one. */
function otherMode(mode: DiffMode): DiffMode {
  if (mode === "split") {
    return "inline";
  }
  return "split";
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
