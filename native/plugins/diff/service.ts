// The `diff` service: diff views in panes of their own, diffs drawn over a file in an ordinary
// editor pane (see `inline.ts`), and the hunk actions that work on the editor's cursor.
//
// A diff view is one or two editors over documents, with the difference drawn as
// decorations by the host (see `src/diff.rs`): inline, one editor over the new text with the removed
// lines as blocks; or split, an editor for the old text beside one for the new, with fillers so
// the rows of a hunk line up. The right side is the file's own document, so it can be edited and
// saved as in any editor. State is plain fields with a change signal, never `$state`.
//
// Other plugins open a diff with `ctx.diff.open({ path, base: "head" })`, or of two texts with
// `ctx.diff.openTexts(...)`.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { DocumentEvent, EditorService, EditorViewMethods } from "../editor/service";
import type { DiffHost, GitBase } from "./diffHost";
import { InlineDiffs, type InlineEntry, type InlineView } from "./inline";
import {
  baseLabel,
  fileName,
  hunkAtRow,
  normalizeRequest,
  requestTitle,
  sameRequest,
  stepHunkRow,
  type DiffBase,
  type DiffMode,
  type DiffOpenRequest,
  type DiffPaneState,
  type DiffRequest,
  type Hunk,
} from "./model";

export { baseLabel, fileName, hunkPosition, stepHunkRow } from "./model";
export type { DiffBase, DiffMode, DiffOpenRequest, DiffRequest, Hunk } from "./model";
export type { InlineEntry, InlineView } from "./inline";

declare module "@neoworks/extension-system" {
  interface Context {
    diff: DiffService;
  }
}

/** The pane type diff views are drawn in. */
export const DIFF_PANE_TYPE = "diff";

/** The decoration source the normal editor's hunk preview draws under. */
export const PREVIEW_SOURCE = "git.preview";

/** How long edits are gathered before the difference is worked out again. */
const REAPPLY_DELAY_MS = 120;

/** How long file system events are gathered before the git side of the diffs is read again. */
const FILES_CHANGED_DELAY_MS = 400;

/** What the service needs from the layout. */
export interface DiffPaneHost {
  readonly focusedLeafId: string;
  leafIds(): string[];
  paneTypeOf(leafId: string): string | undefined;
  paneState(leafId: string): Record<string, unknown>;
  setPaneState(leafId: string, patch: Record<string, unknown>): void;
  splitFocused(direction: "row" | "column", paneTypeId?: string): void;
  focus(leafId: string): void;
  onPaneClosed(listener: (leafId: string) => void): () => void;
  onPaneSplit(listener: (newLeafId: string, sourceLeafId: string) => void): () => void;
}

export interface DiffOptions {
  /** Hears of changes to files on disk. Returns the function that stops. */
  onFilesChanged?: (handler: () => void) => () => void;
}

/** What a diff pane draws. */
export interface DiffView {
  status: "loading" | "ready" | "error";
  /** Why it could not be shown, when `status` is "error". */
  message: string;
  /** The file's name, for the pane's title. */
  title: string;
  /** Where the old side comes from: "HEAD", "Index", "Staged" or what a caller called it. */
  baseLabel: string;
  mode: DiffMode;
  /** The document of the new text, which has the cursor and, for a file, takes edits. */
  rightId: number | null;
  /** The document of the old text, in split mode. */
  leftId: number | null;
  /** Whether the right side is the file's own document, which can be edited and saved. */
  editable: boolean;
  hunks: Hunk[];
  /** What the hunk actions of the header can do. */
  canStage: boolean;
  canUnstage: boolean;
  canRevert: boolean;
}

/** A diff pane's state beyond what it draws. */
interface PaneRecord {
  request: DiffRequest;
  view: DiffView;
  oldText: string;
  /** The newest load, so one that is overtaken drops what it read. */
  generation: number;
  /** The editors drawing it, which are asked to draw again when the decorations change. */
  editors: { left?: EditorViewMethods; right?: EditorViewMethods };
  reapplyTimer: ReturnType<typeof setTimeout> | undefined;
  /** The drawing in progress, which the next one waits for so two never open the old side's document twice. */
  drawing: Promise<void>;
}

/** The old text of a diff and the document that has the new text. */
interface Sides {
  oldText: string;
  rightId: number;
  editable: boolean;
}

export class DiffService extends Service {
  private records = new Map<string, PaneRecord>();
  private noticeText = "";
  private changes: ChangeSignal = createChangeSignal();
  private nextGeneration = 0;
  private filesTimer: ReturnType<typeof setTimeout> | undefined;
  /** The load each pane has under way, so another one for the same pane waits for it. */
  private loading = new Map<string, Promise<void>>();
  /** The documents that show a hunk preview, with the rows of the hunk. */
  private previews = new Map<number, Hunk>();
  /** The mode a diff opens in. */
  private defaultMode: DiffMode = "inline";
  private indexListeners = new Set<() => void>();
  /** The diffs drawn over files in editor panes. */
  private inline: InlineDiffs;
  private inlineListeners = new Set<() => void>();

  constructor(
    ctx: Context,
    private editor: EditorService,
    private panes: DiffPaneHost,
    private host: DiffHost,
    options: DiffOptions = {},
  ) {
    super(ctx, "diff");
    this.inline = new InlineDiffs(editor, host, {
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
    ctx.effect(() => panes.onPaneClosed((leafId) => this.background(this.paneClosed(leafId), "closing a pane")), "diff.paneClosed");
    ctx.effect(() => panes.onPaneSplit((newLeafId, sourceLeafId) => this.paneSplit(newLeafId, sourceLeafId)), "diff.paneSplit");
    if (options.onFilesChanged) {
      const onFilesChanged = options.onFilesChanged;
      ctx.effect(() => onFilesChanged(() => this.scheduleFilesChanged()), "diff.files");
    }
    ctx.effect(() => () => this.cancelTimers(), "diff.timers");
  }

  /**
   * Shows a diff in a pane: the pane that already shows it, else a diff pane, else a new pane
   * split off the focused one. Resolves to the pane, or null when the pane could not be made.
   */
  async open(wanted: DiffOpenRequest, mode?: DiffMode): Promise<string | null> {
    const request = normalizeRequest(wanted);
    const showing = this.paneIds().find((leafId) => this.sameAsShown(leafId, request));
    if (showing !== undefined) {
      this.panes.focus(showing);
      return showing;
    }
    const leafId = this.paneFor();
    if (leafId === null) {
      return null;
    }
    let chosen = this.defaultMode;
    if (mode !== undefined) {
      chosen = mode;
    }
    this.panes.setPaneState(leafId, { diff: { request, mode: chosen } satisfies DiffPaneState });
    this.panes.focus(leafId);
    await this.load(leafId);
    return leafId;
  }

  /**
   * Shows how a file differs from a base in an editor pane, drawn over the file itself, with the
   * file opened there if it is not. Falls back to a diff pane when there is no editor pane to
   * draw it in. Resolves to whether it was drawn in an editor.
   */
  async showInEditor(path: string, base: DiffBase = "head"): Promise<boolean> {
    if (await this.inline.show(path, base)) {
      return true;
    }
    await this.openFile(path, base);
    return false;
  }

  /** Shows the focused editor's file against HEAD over the file, or takes the diff off when it shows. */
  async toggleInEditor(): Promise<void> {
    const active = this.editor.active();
    if (active === null || active.path === "") {
      this.say("Open a file to see its changes.");
      return;
    }
    const leafId = this.panes.focusedLeafId;
    if (this.inline.viewOf(leafId, active.id) !== undefined) {
      await this.inline.hide(leafId, active.id);
      return;
    }
    await this.inline.show(active.path, "head");
  }

  /** Takes the diff off the file the focused editor shows. */
  async hideInEditor(): Promise<void> {
    const active = this.editor.active();
    if (active !== null) {
      await this.inline.hide(this.panes.focusedLeafId, active.id);
    }
  }

  /** Every diff drawn over a file in an editor pane. Reactive. */
  inlineViews(): InlineEntry[] {
    this.changes.track();
    return this.inline.entries();
  }

  /** Hears when a diff over a file appears, goes or is worked out again. Returns the function that stops it. */
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

  /** The diff an editor pane shows over a document, or undefined. Reactive. */
  inlineView(leafId: string, documentId: number): InlineView | undefined {
    this.changes.track();
    return this.inline.viewOf(leafId, documentId);
  }

  /** Shows how a file in the working tree differs from a base, HEAD by default, in a diff pane. */
  openFile(path: string, base: DiffBase = "head", mode?: DiffMode): Promise<string | null> {
    return this.open({ kind: "file", path, base }, mode);
  }

  /** Shows how two texts differ. `name`'s extension says what language they are. */
  openTexts(name: string, oldText: string, newText: string, label = "Before", mode?: DiffMode): Promise<string | null> {
    return this.open({ kind: "texts", name, label, oldText, newText }, mode);
  }

  /** What a diff pane draws, or undefined while it has nothing to show. Reactive. */
  view(leafId: string): DiffView | undefined {
    this.changes.track();
    return this.records.get(leafId)?.view;
  }

  /** The title of a diff pane. Reactive. */
  paneTitle(leafId: string): string {
    this.changes.track();
    const record = this.records.get(leafId);
    if (record === undefined) {
      const state = this.stateOf(leafId);
      if (state === null) {
        return "Diff";
      }
      return `${requestTitle(state.request)} (diff)`;
    }
    return `${record.view.title} (${record.view.baseLabel})`;
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
    const reloads = [...this.records.keys()].map((leafId) => this.reloadBase(leafId));
    await Promise.all([...reloads, this.inline.reloadAll()]);
  }

  /** The mode diffs open in. Reactive. */
  mode(): DiffMode {
    this.changes.track();
    return this.defaultMode;
  }

  /** Loads the diff a pane's state asks for, when the pane has not loaded one, as a pane made by a split has not. */
  ensureLoaded(leafId: string): void {
    if (this.records.has(leafId) || this.loading.has(leafId) || this.stateOf(leafId) === null) {
      return;
    }
    this.background(this.load(leafId), "loading a diff");
  }

  /** Lets commands and the pane's refreshes reach the editors drawing a diff while they are mounted. */
  registerEditors(leafId: string, editors: { left?: EditorViewMethods; right?: EditorViewMethods }): () => void {
    const record = this.records.get(leafId);
    if (record === undefined) {
      return () => {};
    }
    record.editors = editors;
    return () => {
      if (record.editors === editors) {
        record.editors = {};
      }
    };
  }

  /** Shows a diff in the other mode. */
  async setMode(leafId: string, mode: DiffMode): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined || record.view.mode === mode) {
      return;
    }
    this.defaultMode = mode;
    this.panes.setPaneState(leafId, { diff: { request: record.request, mode } satisfies DiffPaneState });
    record.view = { ...record.view, mode };
    this.changes.notify();
    await this.applyDiff(leafId);
  }

  /** Switches the focused diff pane between inline and side by side. */
  async toggleMode(leafId: string = this.panes.focusedLeafId): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined) {
      return;
    }
    let next: DiffMode = "split";
    if (record.view.mode === "split") {
      next = "inline";
    }
    await this.setMode(leafId, next);
  }

  /** Whether the focused pane shows a diff. Reactive. */
  hasFocusedDiff(): boolean {
    this.changes.track();
    return this.records.has(this.panes.focusedLeafId);
  }

  /** Moves the cursor to the next (1) or previous (-1) change, in the focused diff or else the focused editor. */
  async stepChange(step: 1 | -1): Promise<void> {
    const leafId = this.panes.focusedLeafId;
    if (this.records.has(leafId)) {
      await this.stepPane(leafId, step);
      return;
    }
    await this.stepEditor(step);
  }

  /** Stages the hunk under the cursor of the focused diff pane, or of the focused editor. */
  async stageHunk(): Promise<void> {
    const record = this.records.get(this.panes.focusedLeafId);
    if (record === undefined) {
      await this.stageInEditor();
      return;
    }
    if (!record.view.canStage || record.view.rightId === null) {
      this.say("This diff has no unstaged changes to stage.");
      return;
    }
    await this.stageInPane(record, record.view.rightId);
  }

  /** Takes the hunk under the cursor of the focused staged diff out of the index. */
  async unstageHunk(): Promise<void> {
    const leafId = this.panes.focusedLeafId;
    const record = this.records.get(leafId);
    if (record === undefined || record.request.kind !== "file" || !record.view.canUnstage) {
      this.say("Unstage works in a diff of the staged changes.");
      return;
    }
    const path = record.request.path;
    const ok = await this.attempt(() => this.host.unstageHunk(path, this.cursorRow(record)), "Unstaged the hunk.");
    if (ok) {
      await this.indexChanged();
    }
  }

  /** Puts the old lines of the hunk under the cursor back, in the focused diff pane or editor. */
  async revertHunk(): Promise<void> {
    const record = this.records.get(this.panes.focusedLeafId);
    if (record === undefined) {
      await this.revertInEditor();
      return;
    }
    const base = gitBaseOf(record.request);
    if (!record.view.canRevert || base === null || record.view.rightId === null) {
      this.say("Only a diff of a file against HEAD or the index can be reverted.");
      return;
    }
    const rightId = record.view.rightId;
    await this.attempt(() => this.host.revertHunk(rightId, base, this.cursorRow(record)), "Reverted the hunk.");
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

  /** The name a diff pane's decorations are drawn under. It belongs to the pane's editors alone, so the file's other views do not show it. */
  private sourceOf(leafId: string): string {
    return `view:${leafId}:diff`;
  }

  /** The ids of the panes that show diffs. */
  private paneIds(): string[] {
    return this.panes.leafIds().filter((leafId) => this.panes.paneTypeOf(leafId) === DIFF_PANE_TYPE);
  }

  /** The diff a pane's state asks for, or null. */
  private stateOf(leafId: string): DiffPaneState | null {
    const state = this.panes.paneState(leafId).diff as DiffPaneState | undefined;
    if (state === undefined) {
      return null;
    }
    return state;
  }

  /** Whether a pane shows, or is about to show, this diff. */
  private sameAsShown(leafId: string, request: DiffRequest): boolean {
    const state = this.stateOf(leafId);
    return state !== null && sameRequest(state.request, request);
  }

  /** The pane a diff goes to: the focused diff pane, else the first one, else a new one split off the focused pane. */
  private paneFor(): string | null {
    const ids = this.paneIds();
    const focused = this.panes.focusedLeafId;
    if (ids.includes(focused)) {
      return focused;
    }
    if (ids.length > 0) {
      return ids[0];
    }
    this.panes.splitFocused("row", DIFF_PANE_TYPE);
    const created = this.panes.focusedLeafId;
    if (this.panes.paneTypeOf(created) !== DIFF_PANE_TYPE) {
      return null;
    }
    return created;
  }

  /** Reads what a pane's diff compares and shows it, once the load the pane already has under way is done. */
  private load(leafId: string): Promise<void> {
    const previous = this.loading.get(leafId);
    let run: Promise<void>;
    if (previous === undefined) {
      run = this.loadNow(leafId);
    } else {
      run = previous.then(() => this.loadNow(leafId));
    }
    this.loading.set(leafId, run);
    const forget = () => {
      if (this.loading.get(leafId) === run) {
        this.loading.delete(leafId);
      }
    };
    run.then(forget, forget);
    return run;
  }

  /** Lets go of what the pane drew before, reads its diff again and shows it. */
  private async loadNow(leafId: string): Promise<void> {
    const state = this.stateOf(leafId);
    if (state === null) {
      return;
    }
    await this.discardRecord(leafId);
    this.nextGeneration += 1;
    const generation = this.nextGeneration;
    const record: PaneRecord = {
      request: state.request,
      view: loadingView(state),
      oldText: "",
      generation,
      editors: {},
      reapplyTimer: undefined,
      drawing: Promise.resolve(),
    };
    this.records.set(leafId, record);
    this.changes.notify();
    let sides: Sides;
    try {
      sides = await this.readSides(state.request);
    } catch (error) {
      this.fail(record, error);
      return;
    }
    if (!this.isCurrent(leafId, record) || record.generation !== generation) {
      await this.releaseQuietly(sides.rightId);
      return;
    }
    record.oldText = sides.oldText;
    record.view = readyView(state, sides);
    this.changes.notify();
    await this.applyDiff(leafId);
  }

  /** Reads the old text of a diff and opens the document that has the new one. */
  private async readSides(request: DiffRequest): Promise<Sides> {
    if (request.kind === "texts") {
      const rightId = await this.openTextDocument(request.name, request.newText);
      return { oldText: request.oldText, rightId, editable: false };
    }
    const name = fileName(request.path);
    if (request.base === "staged") {
      const head = await this.host.baseText(request.path, "head");
      const index = await this.host.baseText(request.path, "index");
      const rightId = await this.openTextDocument(name, index.text);
      return { oldText: head.text, rightId, editable: false };
    }
    const oldText = await this.oldTextOf(request.path, request.base);
    const fileId = await this.editor.openDocument(request.path);
    if (fileId === null) {
      // The file is gone, as a deleted one is: there is nothing on the new side.
      const rightId = await this.openTextDocument(name, "");
      return { oldText, rightId, editable: false };
    }
    return { oldText, rightId: fileId, editable: true };
  }

  /** The text the old side of a file's diff has. */
  private async oldTextOf(path: string, base: DiffBase): Promise<string> {
    if (typeof base === "object") {
      return base.text;
    }
    if (base === "staged") {
      return (await this.host.baseText(path, "head")).text;
    }
    return (await this.host.baseText(path, base)).text;
  }

  /** Makes a document of text without a file, or fails with a sentence. */
  private async openTextDocument(name: string, text: string): Promise<number> {
    const documentId = await this.editor.openText(name, text);
    if (documentId === null) {
      throw new Error(`could not show ${name}`);
    }
    return documentId;
  }

  /** Draws the difference on the documents in the pane's mode, and keeps the hunks. One drawing of a pane runs at a time. */
  private async applyDiff(leafId: string): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined) {
      return;
    }
    const drawing = record.drawing.then(() => this.drawDiff(leafId, record));
    record.drawing = drawing.catch(() => {});
    await drawing;
  }

  /** One drawing: stops as soon as the pane's diff is not the one it started with, since its documents are gone by then. */
  private async drawDiff(leafId: string, record: PaneRecord): Promise<void> {
    if (!this.isCurrent(leafId, record) || record.view.rightId === null) {
      return;
    }
    const source = this.sourceOf(leafId);
    const rightId = record.view.rightId;
    try {
      const leftId = await this.settleLeft(leafId, record, source);
      if (leftId === undefined) {
        return;
      }
      const options = { newId: rightId, oldText: record.oldText, mode: record.view.mode, source };
      let hunks: Hunk[];
      if (leftId === null) {
        hunks = await this.host.apply(options);
      } else {
        hunks = await this.host.apply({ ...options, oldId: leftId });
      }
      if (!this.isCurrent(leafId, record)) {
        return;
      }
      record.view = withActions(record.request, { ...record.view, leftId, hunks });
    } catch (error) {
      if (this.isCurrent(leafId, record)) {
        this.fail(record, error);
      }
      return;
    }
    this.changes.notify();
    await this.refreshEditors(leafId, record);
  }

  /**
   * Gives the pane the old side's document its mode needs: one in split mode, none inline. Answers
   * its id or null, or undefined when the pane went away meanwhile, which leaves nothing opened.
   */
  private async settleLeft(leafId: string, record: PaneRecord, source: string): Promise<number | null | undefined> {
    const leftId = record.view.leftId;
    if (record.view.mode !== "split") {
      if (leftId !== null) {
        // Taken off the record first, so a pane closing meanwhile does not release it a second time.
        record.view = { ...record.view, leftId: null };
        await this.editor.setDecorationsOf(leftId, source, []);
        await this.editor.releaseDocument(leftId);
      }
      return null;
    }
    const shown = await this.showLeft(record, leftId);
    if (!this.isCurrent(leafId, record)) {
      if (shown !== leftId) {
        await this.releaseQuietly(shown);
      }
      return undefined;
    }
    record.view = { ...record.view, leftId: shown };
    return shown;
  }

  /** Makes sure the old side's document has the old text, and answers its id. */
  private async showLeft(record: PaneRecord, leftId: number | null): Promise<number> {
    const name = fileName(requestName(record.request));
    if (leftId === null) {
      return this.openTextDocument(name, record.oldText);
    }
    const current = await this.editor.textOf(leftId);
    if (current !== record.oldText) {
      await this.editor.setText(leftId, record.oldText);
    }
    return leftId;
  }

  /** Asks the editors drawing a diff to draw again, unless the diff is gone and so are they. */
  private async refreshEditors(leafId: string, record: PaneRecord): Promise<void> {
    if (!this.isCurrent(leafId, record)) {
      return;
    }
    const refreshes: Promise<void>[] = [];
    if (record.editors.left !== undefined) {
      refreshes.push(this.refreshQuietly(record.editors.left));
    }
    if (record.editors.right !== undefined) {
      refreshes.push(this.refreshQuietly(record.editors.right));
    }
    await Promise.all(refreshes);
  }

  /** Asks one editor to draw again. One that is being unmounted cannot, which is no reason to fail the drawing. */
  private async refreshQuietly(view: EditorViewMethods): Promise<void> {
    try {
      await view.refresh();
    } catch (error) {
      this.ctx.logger.warn(`diff: could not redraw an editor: ${describeError(error)}`);
    }
  }

  /** Reads the git side of a diff again, such as after something was staged, and draws it. */
  private async reloadBase(leafId: string): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined || record.request.kind !== "file" || record.view.rightId === null) {
      return;
    }
    const request = record.request;
    const rightId = record.view.rightId;
    try {
      if (request.base === "staged") {
        const index = await this.host.baseText(request.path, "index");
        if (!this.isCurrent(leafId, record)) {
          return;
        }
        await this.editor.setText(rightId, index.text);
      }
      const oldText = await this.oldTextOf(request.path, request.base);
      if (!this.isCurrent(leafId, record)) {
        return;
      }
      record.oldText = oldText;
    } catch (error) {
      if (this.isCurrent(leafId, record)) {
        this.fail(record, error);
      }
      return;
    }
    await this.applyDiff(leafId);
  }

  /** Where the cursor of the diff's new side is, as a row. */
  private cursorRow(record: PaneRecord): number {
    if (record.view.rightId === null) {
      return 0;
    }
    return this.rowOf(record.view.rightId);
  }

  /** The row a document's cursor is on, the first until it has moved. */
  private rowOf(documentId: number): number {
    const cursor = this.editor.cursorOf(documentId);
    if (cursor === null) {
      return 0;
    }
    return cursor.row;
  }

  /** Moves the cursor of a diff pane to the next or previous hunk, and scrolls it to the middle. */
  private async stepPane(leafId: string, step: 1 | -1): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined || record.editors.right === undefined) {
      return;
    }
    const row = stepHunkRow(record.view.hunks, this.cursorRow(record), step);
    if (row === null) {
      this.say("There are no changes.");
      return;
    }
    const editor = record.editors.right;
    await this.attempt(async () => {
      await editor.apply({ type: "place_cursor", at: { row, column: 0 } });
      await editor.apply({ type: "scroll_to", align: "center" });
    });
  }

  /** Moves the editor's cursor to the next or previous change: of the diff drawn over the file, else against HEAD. */
  private async stepEditor(step: 1 | -1): Promise<void> {
    const active = this.editor.active();
    if (active === null || active.path === "") {
      return;
    }
    await this.attempt(async () => {
      const hunks = await this.hunksOfEditor(active.id, active.path);
      const row = stepHunkRow(hunks, this.rowOf(active.id), step);
      if (row === null) {
        this.say("There are no changes.");
        return;
      }
      await this.editor.applyToFocused({ type: "place_cursor", at: { row, column: 0 } });
      await this.editor.applyToFocused({ type: "scroll_to", align: "center" });
    });
  }

  /** The hunks the focused editor's document has: those of the diff drawn over it, else against HEAD. */
  private async hunksOfEditor(documentId: number, path: string): Promise<Hunk[]> {
    const shown = this.inline.viewOf(this.panes.focusedLeafId, documentId);
    if (shown !== undefined) {
      return shown.hunks;
    }
    const base = await this.host.baseText(path, "head");
    return this.host.hunks(documentId, base.text);
  }

  /** Stages a hunk from a diff pane and shows the result. */
  private async stageInPane(record: PaneRecord, rightId: number): Promise<void> {
    const ok = await this.attempt(() => this.host.stageHunk(rightId, this.cursorRow(record)), "Staged the hunk.");
    if (ok) {
      await this.indexChanged();
    }
  }

  /** Stages the hunk under the cursor of the active editor. */
  private async stageInEditor(): Promise<void> {
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

  /** Puts back the lines of the hunk under the cursor of the active editor, as HEAD has them. */
  private async revertInEditor(): Promise<void> {
    const active = this.editor.active();
    if (active === null || active.path === "") {
      this.say("Open a file to revert its changes.");
      return;
    }
    const shown = this.inline.viewOf(this.panes.focusedLeafId, active.id);
    let base: GitBase = "head";
    if (shown !== undefined) {
      if (shown.gitBase === null) {
        this.say("Only a diff against HEAD or the index can be reverted.");
        return;
      }
      base = shown.gitBase;
    }
    const row = this.rowOf(active.id);
    await this.attempt(() => this.host.revertHunk(active.id, base, row), "Reverted the hunk.");
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

  /** Records what a diff could not be shown for. */
  private fail(record: PaneRecord, error: unknown): void {
    record.view = { ...record.view, status: "error", message: describeError(error) };
    this.changes.notify();
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
      this.scheduleReapply(event.id);
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

  /** Works the difference out again once the edits to a diff's new side stop. */
  private scheduleReapply(documentId: number): void {
    for (const [leafId, record] of this.records) {
      if (record.view.rightId !== documentId) {
        continue;
      }
      clearTimeout(record.reapplyTimer);
      record.reapplyTimer = setTimeout(() => this.background(this.applyDiff(leafId), "drawing the changes"), REAPPLY_DELAY_MS);
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
    this.filesTimer = setTimeout(() => {
      for (const leafId of [...this.records.keys()]) {
        this.background(this.reloadBase(leafId), "reading the changes again");
      }
      this.background(this.inline.reloadAll(), "reading the changes again");
    }, FILES_CHANGED_DELAY_MS);
  }

  /** Stops the timers that are pending. */
  private cancelTimers(): void {
    clearTimeout(this.filesTimer);
    this.inline.cancelTimers();
    for (const record of this.records.values()) {
      clearTimeout(record.reapplyTimer);
    }
  }

  /** A pane closed: its diff lets go of its documents. */
  private async paneClosed(leafId: string): Promise<void> {
    this.inline.onPaneClosed(leafId);
    await this.discardRecord(leafId);
  }

  /** A split of a diff pane shows the same diff as the pane it came from. */
  private paneSplit(newLeafId: string, sourceLeafId: string): void {
    if (this.panes.paneTypeOf(newLeafId) !== DIFF_PANE_TYPE) {
      return;
    }
    const state = this.stateOf(sourceLeafId);
    if (state === null) {
      return;
    }
    this.panes.setPaneState(newLeafId, { diff: state });
  }

  /** Takes a pane's drawing off its documents and lets them go. */
  private async discardRecord(leafId: string): Promise<void> {
    const record = this.records.get(leafId);
    if (record === undefined) {
      return;
    }
    clearTimeout(record.reapplyTimer);
    this.records.delete(leafId);
    record.editors = {};
    this.changes.notify();
    const source = this.sourceOf(leafId);
    for (const documentId of [record.view.leftId, record.view.rightId]) {
      if (documentId === null) {
        continue;
      }
      await this.editor.setDecorationsOf(documentId, source, []).catch(() => {});
      await this.releaseQuietly(documentId);
    }
  }

  /** Whether this record is still the one the pane has, which is not so once the pane closed or loaded again. */
  private isCurrent(leafId: string, record: PaneRecord): boolean {
    return this.records.get(leafId) === record;
  }

  /** Lets go of a document, and says so in the log if that fails: there is nobody to tell. */
  private async releaseQuietly(documentId: number): Promise<void> {
    try {
      await this.editor.releaseDocument(documentId);
    } catch (error) {
      this.ctx.logger.warn(`diff: could not release document ${documentId}: ${describeError(error)}`);
    }
  }

  /** Runs work nobody waits for, and logs what it throws so that it never ends as an unhandled rejection. */
  private background(work: Promise<unknown>, what: string): void {
    work.catch((error) => this.ctx.logger.warn(`diff: ${what} failed: ${describeError(error)}`));
  }
}

/** The git base a request compares against, for the actions that read it again. */
function gitBaseOf(request: DiffRequest): GitBase | null {
  if (request.kind === "file" && (request.base === "head" || request.base === "index")) {
    return request.base;
  }
  return null;
}

/** The name of the file a request is about. */
function requestName(request: DiffRequest): string {
  if (request.kind === "file") {
    return request.path;
  }
  return request.name;
}

/** What a pane draws while it reads its diff. */
function loadingView(state: DiffPaneState): DiffView {
  return {
    status: "loading",
    message: "",
    title: requestTitle(state.request),
    baseLabel: labelOf(state.request),
    mode: state.mode,
    rightId: null,
    leftId: null,
    editable: false,
    hunks: [],
    canStage: false,
    canUnstage: false,
    canRevert: false,
  };
}

/** The label of what a request's old side is. */
function labelOf(request: DiffRequest): string {
  if (request.kind === "texts") {
    return request.label;
  }
  return baseLabel(request.base);
}

/** What a pane draws once the new side's document exists. */
function readyView(state: DiffPaneState, sides: Sides): DiffView {
  const view: DiffView = {
    ...loadingView(state),
    status: "ready",
    rightId: sides.rightId,
    editable: sides.editable,
  };
  return withActions(state.request, view);
}

/** The view with what its header's actions can do worked out from the request. */
function withActions(request: DiffRequest, view: DiffView): DiffView {
  const isFile = request.kind === "file";
  const base = isFile ? request.base : null;
  return {
    ...view,
    canStage: view.editable && isFile && (base === "head" || base === "index"),
    canUnstage: isFile && base === "staged",
    canRevert: view.editable && isFile && (base === "head" || base === "index"),
  };
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
