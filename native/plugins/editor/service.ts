// The `editor` service: which files are open, which tab each pane shows, and what happens when
// one is opened, saved or closed. The text itself lives in Rust, in documents the editor
// element shows by id (see `src/editor/documents.rs`), so nothing here is lost when a pane is
// drawn again. State is plain fields with a change signal, never `$state` (see the
// grove-plugins skill).
//
// Other plugins use `ctx.editor.open(path)` and read `buffers()` and `active()`. Panes and
// tabs are this service's own business: each pane has its own tabs and its own active tab,
// and a document may be a tab in several panes at once.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { Decoration } from "./decorations";

export type {
  BlockDecoration,
  Decoration,
  GutterDecoration,
  GutterMark,
  HighlightDecoration,
  InlayDecoration,
  LineEndDecoration,
  TextPosition,
  Tone,
} from "./decorations";

declare module "@neoworks/extension-system" {
  interface Context {
    editor: EditorService;
  }
}

/** The pane type that shows documents; a pane of any other type is never given tabs. */
export const EDITOR_PANE_TYPE = "editor";

/** A document as the host describes it. */
export interface DocumentSummary {
  id: number;
  path: string | null;
  title: string;
  dirty: boolean;
}

/** What the host tells the service about its documents. */
export type DocumentEvent =
  | { type: "opened"; summary: DocumentSummary }
  | { type: "closed"; id: number }
  | { type: "dirty"; id: number; dirty: boolean }
  | { type: "saved"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "selections"; id: number; row: number; column: number; count: number; selected: boolean }
  | { type: "mode"; mode: string; pending: string; commandLine: string | null }
  | { type: "close-request"; id: number; discard: boolean }
  | { type: "open-request"; id: number; path: string };

/** The documents the Rust host keeps. A test supplies a fake. */
export interface DocumentHost {
  /** Opens a file, or finds the document that already has it. Rejects with the reason it failed. */
  open(path: string): Promise<DocumentSummary>;
  /** Closes a document, throwing away unsaved changes. */
  close(id: number): Promise<void>;
  /** Writes a document to its file. Rejects with the reason it failed. */
  save(id: number): Promise<void>;
  /** Replaces what one source has put on top of a document's text. An empty list removes the source's. */
  setDecorations(id: number, source: string, decorations: Decoration[]): Promise<void>;
  /** Hears of everything that happens to documents. Returns the function that stops it. */
  onEvent(handler: (event: DocumentEvent) => void): () => void;
}

/** What the service needs from the layout: where the focus is and when panes come and go. */
export interface PaneHost {
  readonly focusedLeafId: string;
  leafIds(): string[];
  paneTypeOf(leafId: string): string | undefined;
  focus(leafId: string): void;
  onPaneSplit(listener: (newLeafId: string, sourceLeafId: string) => void): () => void;
  onPaneClosed(listener: (leafId: string) => void): () => void;
}

/** The methods the editor element has, which a pane's view registers so commands can reach it. */
export interface EditorViewMethods {
  apply(command: { type: string }): Promise<{ changed: boolean }>;
  /** Draws the view again, such as after the decorations of its document changed. */
  refresh(): Promise<void>;
}

/** An open document, as other plugins see it. */
export interface BufferInfo {
  id: number;
  path: string;
  title: string;
  dirty: boolean;
}

/** Where the newest cursor of a document is, counted from zero. */
export interface CursorInfo {
  row: number;
  column: number;
  count: number;
  selected: boolean;
}

/** Which keys the editor understands: VS Code's, or vim's. */
export type KeymapName = "standard" | "vim";

/** What the vim layer reports: its mode, the keys it is waiting on, and the line typed after `:`. */
export interface VimStatus {
  /** `NORMAL`, `INSERT`, `VISUAL`, `V-LINE` or `REPLACE`; empty while the keys are the standard ones. */
  mode: string;
  pending: string;
  commandLine: string | null;
}

/** What a prompt asking about unsaved changes can be answered with. */
export type CloseChoice = "save" | "discard" | "cancel";

/** A question the shell is waiting on, drawn by an overlay. */
export type Prompt = { kind: "confirm-close"; documentId: number; title: string } | { kind: "open-file" };

/** The tabs of one pane: documents in the order they were opened there, and the one shown. */
interface PaneTabs {
  tabs: number[];
  active: number | null;
}

export class EditorService extends Service {
  private documentsById = new Map<number, BufferInfo>();
  private paneTabs = new Map<string, PaneTabs>();
  private viewsByLeaf = new Map<string, EditorViewMethods>();
  private cursorsById = new Map<number, CursorInfo>();
  private promptState: Prompt | null = null;
  private answerClose: ((choice: CloseChoice) => void) | null = null;
  private messageText = "";
  private changes: ChangeSignal = createChangeSignal();
  private keymapName: KeymapName = "standard";
  private vimState: VimStatus = { mode: "", pending: "", commandLine: null };
  private documentListeners = new Set<(event: DocumentEvent) => void>();

  constructor(
    ctx: Context,
    private host: DocumentHost,
    private panes: PaneHost,
  ) {
    super(ctx, "editor");
    ctx.effect(() => host.onEvent((event) => this.handleEvent(event)), "editor.documents");
    ctx.effect(() => panes.onPaneSplit((newLeafId, sourceLeafId) => this.paneSplit(newLeafId, sourceLeafId)), "editor.paneSplit");
    ctx.effect(() => panes.onPaneClosed((leafId) => this.paneClosed(leafId)), "editor.paneClosed");
  }

  /**
   * Opens a file and shows it in the focused pane, or in the first editor pane when the focus is
   * on another kind. A file that is already open is shown as it is, with its edits.
   */
  open(path: string): void {
    void this.openPath(path);
  }

  /** Like `open`, and resolves to the document's id once it is shown, or null when it could not be opened. */
  async openPath(path: string): Promise<number | null> {
    let summary: DocumentSummary;
    try {
      summary = await this.host.open(path);
    } catch (error) {
      this.setMessage(describeError(error));
      return null;
    }
    this.adopt(summary);
    const leafId = this.targetLeafId();
    if (leafId === null) {
      return summary.id;
    }
    this.showIn(leafId, summary.id, true);
    this.panes.focus(leafId);
    this.setMessage("");
    return summary.id;
  }

  /** Every open document, in the order they were opened. Reactive. */
  buffers(): BufferInfo[] {
    this.changes.track();
    return [...this.documentsById.values()];
  }

  /** The document the focused pane shows, or null. Reactive. */
  active(): BufferInfo | null {
    return this.activeIn(this.panes.focusedLeafId);
  }

  /** The document a pane shows, or null. Reactive. */
  activeIn(leafId: string): BufferInfo | null {
    this.changes.track();
    const activeId = this.paneTabs.get(leafId)?.active;
    if (activeId === undefined || activeId === null) {
      return null;
    }
    const info = this.documentsById.get(activeId);
    if (!info) {
      return null;
    }
    return info;
  }

  /** The tabs of a pane, in order. Reactive. */
  tabsIn(leafId: string): BufferInfo[] {
    this.changes.track();
    const pane = this.paneTabs.get(leafId);
    if (!pane) {
      return [];
    }
    const tabs: BufferInfo[] = [];
    for (const id of pane.tabs) {
      const info = this.documentsById.get(id);
      if (info) {
        tabs.push(info);
      }
    }
    return tabs;
  }

  /** Where the newest cursor of a document is, or null before it has moved. Reactive. */
  cursorOf(id: number): CursorInfo | null {
    this.changes.track();
    const cursor = this.cursorsById.get(id);
    if (!cursor) {
      return null;
    }
    return cursor;
  }

  /** Which keys the editors understand. Reactive. */
  keymap(): KeymapName {
    this.changes.track();
    return this.keymapName;
  }

  /** Switches every editor between the standard keys and vim's. Anything else is the standard keys. */
  setKeymap(name: string): void {
    this.keymapName = name === "vim" ? "vim" : "standard";
    if (this.keymapName === "standard") {
      this.vimState = { mode: "", pending: "", commandLine: null };
    }
    this.changes.notify();
  }

  /** The vim layer's mode and pending keys, as the last editor to change them reported. Reactive. */
  vimStatus(): VimStatus {
    this.changes.track();
    return this.vimState;
  }

  /** Closes a document, throwing its unsaved changes away without asking, as `:q!` does. */
  async discard(documentId: number): Promise<void> {
    if (!this.documentsById.has(documentId)) {
      return;
    }
    await this.host.close(documentId);
    this.forget(documentId);
  }

  /** The last thing worth telling the person, such as a failed save. Reactive. */
  message(): string {
    this.changes.track();
    return this.messageText;
  }

  /** Gives a pane the focus, as pressing in its editor does. */
  focusPane(leafId: string): void {
    this.panes.focus(leafId);
  }

  /** Whether a pane has the focus. Reactive. */
  isFocusedPane(leafId: string): boolean {
    return this.panes.focusedLeafId === leafId;
  }

  /** Lets commands reach a pane's editor element while it is mounted. Returns the function that lets go. */
  registerView(leafId: string, view: EditorViewMethods): () => void {
    this.viewsByLeaf.set(leafId, view);
    this.changes.notify();
    return () => {
      if (this.viewsByLeaf.get(leafId) === view) {
        this.viewsByLeaf.delete(leafId);
        this.changes.notify();
      }
    };
  }

  /** Whether the focused pane has an editor to take a command. Reactive. */
  hasFocusedView(): boolean {
    this.changes.track();
    return this.viewsByLeaf.has(this.panes.focusedLeafId);
  }

  /** Sends the focused pane's editor one of its commands, such as `undo`, as its own keys would. */
  async sendCommand(type: string): Promise<void> {
    const view = this.viewsByLeaf.get(this.panes.focusedLeafId);
    if (!view) {
      throw new Error(`there is no editor to ${type} in`);
    }
    await view.apply({ type });
  }

  /**
   * Replaces what a source has put on top of an open file's text and draws it. A source is a
   * name such as `git.blame`; its set is replaced whole and others are left alone, and an empty
   * list removes it. Resolves to false when the file is not open.
   */
  async setDecorations(path: string, source: string, decorations: Decoration[]): Promise<boolean> {
    const info = this.bufferAt(path);
    if (!info) {
      return false;
    }
    await this.host.setDecorations(info.id, source, decorations);
    await Promise.all([...this.viewsByLeaf.values()].map((view) => view.refresh()));
    return true;
  }

  /** Removes everything a source has put on a file's text. */
  clearDecorations(path: string, source: string): Promise<boolean> {
    return this.setDecorations(path, source, []);
  }

  /** The open document that has a file, or null. */
  bufferAt(path: string): BufferInfo | null {
    for (const info of this.documentsById.values()) {
      if (info.path === path) {
        return info;
      }
    }
    return null;
  }

  /** Hears of what happens to documents: opened, closed, saved, edited and the cursor moved. Returns the function that stops it. */
  onDocumentEvent(handler: (event: DocumentEvent) => void): () => void {
    this.documentListeners.add(handler);
    return () => {
      this.documentListeners.delete(handler);
    };
  }

  /** Shows a document the pane already has a tab for, and gives that pane the focus. */
  select(leafId: string, documentId: number): void {
    const pane = this.paneTabs.get(leafId);
    if (!pane || !pane.tabs.includes(documentId)) {
      return;
    }
    pane.active = documentId;
    this.panes.focus(leafId);
    this.setMessage("");
  }

  /** Moves to the next tab of the focused pane (1) or the previous one (-1), wrapping at the ends. */
  cycleTabs(step: 1 | -1): void {
    const pane = this.paneTabs.get(this.panes.focusedLeafId);
    if (!pane || pane.tabs.length < 2 || pane.active === null) {
      return;
    }
    const position = pane.tabs.indexOf(pane.active);
    const next = (position + step + pane.tabs.length) % pane.tabs.length;
    pane.active = pane.tabs[next];
    this.changes.notify();
  }

  /** Whether the focused pane has a tab to close. Reactive. */
  hasActiveTab(): boolean {
    return this.active() !== null;
  }

  /**
   * Closes a pane's tab. The document stays open while another pane has a tab for it; closing
   * its last tab closes the document, and asks first when it has unsaved changes. Resolves to
   * false when the person chose to keep it.
   */
  async closeTab(leafId: string, documentId: number): Promise<boolean> {
    const pane = this.paneTabs.get(leafId);
    if (!pane || !pane.tabs.includes(documentId)) {
      return false;
    }
    if (this.isShownElsewhere(documentId, leafId)) {
      this.removeTab(leafId, documentId);
      return true;
    }
    return this.close(documentId);
  }

  /** Closes the focused pane's active tab, as the Close Tab menu item does. */
  async closeActiveTab(): Promise<boolean> {
    const active = this.active();
    if (!active) {
      return false;
    }
    return this.closeTab(this.panes.focusedLeafId, active.id);
  }

  /**
   * Closes a document in every pane. A document with unsaved changes asks first: saving writes
   * it and then closes it, discarding throws the changes away. Resolves to false when the
   * person cancelled or the save failed, and the document stays open.
   */
  async close(documentId: number): Promise<boolean> {
    const info = this.documentsById.get(documentId);
    if (!info) {
      return false;
    }
    if (info.dirty && !(await this.settleUnsavedChanges(info))) {
      return false;
    }
    await this.host.close(documentId);
    this.forget(documentId);
    return true;
  }

  /** Writes a document to its file, the active one when no id is given. Resolves to whether it worked. */
  async save(documentId?: number): Promise<boolean> {
    const target = this.documentToSave(documentId);
    if (target === null) {
      return false;
    }
    try {
      await this.host.save(target);
    } catch (error) {
      this.setMessage(describeError(error));
      return false;
    }
    return true;
  }

  /** The prompt the shell is waiting on, or null. Reactive. */
  prompt(): Prompt | null {
    this.changes.track();
    return this.promptState;
  }

  /** Answers the question about unsaved changes that is open, if one is. */
  answerConfirmClose(choice: CloseChoice): void {
    const answer = this.answerClose;
    this.answerClose = null;
    this.promptState = null;
    this.changes.notify();
    if (answer) {
      answer(choice);
    }
  }

  /** Asks for a path to open, in a field over the editor. */
  requestOpenFile(): void {
    this.cancelPrompt();
    this.promptState = { kind: "open-file" };
    this.changes.notify();
  }

  /** Closes the open-file field, and opens the path that was typed into it unless it was empty. */
  submitOpenFile(path: string): void {
    this.cancelPrompt();
    const trimmed = path.trim();
    if (trimmed !== "") {
      this.open(trimmed);
    }
  }

  /** Dismisses whatever prompt is open; a question about unsaved changes counts as cancelled. */
  cancelPrompt(): void {
    if (this.promptState && this.promptState.kind === "confirm-close") {
      this.answerConfirmClose("cancel");
      return;
    }
    this.promptState = null;
    this.changes.notify();
  }

  /** Records a document the host has, or brings what is known about it up to date. */
  private adopt(summary: DocumentSummary): void {
    let path = "";
    if (summary.path !== null) {
      path = summary.path;
    }
    this.documentsById.set(summary.id, { id: summary.id, path, title: summary.title, dirty: summary.dirty });
    this.changes.notify();
  }

  /** The pane an opened document goes to: the focused one if it shows documents, else the first that does. */
  private targetLeafId(): string | null {
    const focused = this.panes.focusedLeafId;
    if (this.panes.paneTypeOf(focused) === EDITOR_PANE_TYPE) {
      return focused;
    }
    const editorPane = this.panes.leafIds().find((leafId) => this.panes.paneTypeOf(leafId) === EDITOR_PANE_TYPE);
    if (editorPane === undefined) {
      return null;
    }
    return editorPane;
  }

  /** Gives a pane a tab for a document, and shows it there when `activate` is set. */
  private showIn(leafId: string, documentId: number, activate: boolean): void {
    let pane = this.paneTabs.get(leafId);
    if (!pane) {
      pane = { tabs: [], active: null };
      this.paneTabs.set(leafId, pane);
    }
    if (!pane.tabs.includes(documentId)) {
      pane.tabs.push(documentId);
    }
    if (activate || pane.active === null) {
      pane.active = documentId;
    }
    this.changes.notify();
  }

  /** Whether a pane other than `leafId` has a tab for the document. */
  private isShownElsewhere(documentId: number, leafId: string): boolean {
    for (const [otherLeafId, pane] of this.paneTabs) {
      if (otherLeafId !== leafId && pane.tabs.includes(documentId)) {
        return true;
      }
    }
    return false;
  }

  /** Takes a tab out of a pane; if it was the shown one, the tab beside it is shown instead. */
  private removeTab(leafId: string, documentId: number): void {
    const pane = this.paneTabs.get(leafId);
    if (!pane) {
      return;
    }
    const position = pane.tabs.indexOf(documentId);
    if (position === -1) {
      return;
    }
    pane.tabs.splice(position, 1);
    if (pane.active === documentId) {
      pane.active = null;
      if (pane.tabs.length > 0) {
        pane.active = pane.tabs[Math.min(position, pane.tabs.length - 1)];
      }
    }
    this.changes.notify();
  }

  /** Forgets a document that is closed, taking its tab out of every pane. */
  private forget(documentId: number): void {
    for (const leafId of [...this.paneTabs.keys()]) {
      this.removeTab(leafId, documentId);
    }
    this.documentsById.delete(documentId);
    this.cursorsById.delete(documentId);
    this.changes.notify();
  }

  /** Asks what to do with unsaved changes. Resolves to true once it is fine to close the document. */
  private async settleUnsavedChanges(info: BufferInfo): Promise<boolean> {
    const choice = await this.askToSave(info);
    if (choice === "cancel") {
      return false;
    }
    if (choice === "discard") {
      return true;
    }
    return this.save(info.id);
  }

  /** Puts the question about unsaved changes up and waits for its answer. */
  private askToSave(info: BufferInfo): Promise<CloseChoice> {
    this.cancelPrompt();
    return new Promise((resolve) => {
      this.answerClose = resolve;
      this.promptState = { kind: "confirm-close", documentId: info.id, title: info.title };
      this.changes.notify();
    });
  }

  /** The id `save` writes: the one given, else the focused pane's active document. */
  private documentToSave(documentId: number | undefined): number | null {
    if (documentId !== undefined) {
      return documentId;
    }
    const active = this.active();
    if (!active) {
      return null;
    }
    return active.id;
  }

  /** A pane was split: the new one shows what the old one shows. */
  private paneSplit(newLeafId: string, sourceLeafId: string): void {
    if (this.panes.paneTypeOf(newLeafId) !== EDITOR_PANE_TYPE) {
      return;
    }
    const sourceActive = this.paneTabs.get(sourceLeafId)?.active;
    if (sourceActive === undefined || sourceActive === null) {
      return;
    }
    this.showIn(newLeafId, sourceActive, true);
  }

  /** A pane closed: documents only it showed move to a pane that is still there, so none is lost from view. */
  private paneClosed(leafId: string): void {
    const closed = this.paneTabs.get(leafId);
    if (!closed) {
      return;
    }
    this.paneTabs.delete(leafId);
    const survivor = this.targetLeafId();
    if (survivor === null) {
      this.changes.notify();
      return;
    }
    for (const documentId of closed.tabs) {
      if (!this.isShownElsewhere(documentId, leafId)) {
        this.showIn(survivor, documentId, false);
      }
    }
    this.changes.notify();
  }

  /** Applies something the host reports about a document. */
  private handleEvent(event: DocumentEvent): void {
    this.applyEvent(event);
    for (const listener of [...this.documentListeners]) {
      listener(event);
    }
  }

  /** Brings what the service knows up to date with an event. */
  private applyEvent(event: DocumentEvent): void {
    if (event.type === "opened") {
      this.adopt(event.summary);
      return;
    }
    if (event.type === "closed") {
      this.forget(event.id);
      return;
    }
    if (event.type === "dirty") {
      this.markDirty(event.id, event.dirty);
      return;
    }
    if (event.type === "saved") {
      this.setMessage("Saved");
      return;
    }
    if (event.type === "error") {
      this.setMessage(event.message);
      return;
    }
    if (event.type === "mode") {
      this.vimState = { mode: event.mode, pending: event.pending, commandLine: event.commandLine };
      this.changes.notify();
      return;
    }
    if (event.type === "close-request") {
      void this.closeFromCommandLine(event.id, event.discard);
      return;
    }
    if (event.type === "open-request") {
      this.open(event.path);
      return;
    }
    this.cursorsById.set(event.id, { row: event.row, column: event.column, count: event.count, selected: event.selected });
    this.changes.notify();
  }

  /** What `:q` and `:q!` do: close the focused pane's tab, asking about unsaved changes unless discarding. */
  private async closeFromCommandLine(documentId: number, discard: boolean): Promise<void> {
    if (discard) {
      await this.discard(documentId);
      return;
    }
    await this.closeTab(this.panes.focusedLeafId, documentId);
  }

  /** Records whether a document has unsaved changes. */
  private markDirty(documentId: number, dirty: boolean): void {
    const info = this.documentsById.get(documentId);
    if (!info) {
      return;
    }
    this.documentsById.set(documentId, { ...info, dirty });
    if (dirty) {
      this.messageText = "";
    }
    this.changes.notify();
  }

  /** Sets the message and tells readers. */
  private setMessage(text: string): void {
    this.messageText = text;
    this.changes.notify();
  }
}

/** The text of an error a host call rejected with. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
