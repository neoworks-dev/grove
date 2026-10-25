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
import type { Decoration, TextPosition } from "./decorations";

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

/** How a file is indented: tabs, or a number of spaces per level. */
export type IndentStyle = { kind: "tabs" } | { kind: "spaces"; width: number };

/** The styles the palette offers when changing a file's indentation, in the order it lists them. */
export const INDENT_CHOICES: IndentStyle[] = [
  { kind: "tabs" },
  { kind: "spaces", width: 2 },
  { kind: "spaces", width: 4 },
  { kind: "spaces", width: 8 },
];

/** What the status bar calls a style: `Tabs` or `Spaces: 2`. */
export function indentLabel(style: IndentStyle): string {
  if (style.kind === "tabs") {
    return "Tabs";
  }
  return `Spaces: ${style.width}`;
}

/** Reads the `defaultIndent` setting, such as `spaces-2` or `tabs`; anything else is four spaces. */
export function indentFromSetting(value: string): IndentStyle {
  if (value === "tabs") {
    return { kind: "tabs" };
  }
  const width = Number(value.replace("spaces-", ""));
  if (value.startsWith("spaces-") && Number.isInteger(width) && width > 0) {
    return { kind: "spaces", width };
  }
  return { kind: "spaces", width: 4 };
}

/** What the editor's settings tell the host to do. */
export interface EditorOptions {
  /** The indentation of files whose own lines do not say. */
  defaultIndent: IndentStyle;
  smoothScroll: boolean;
  indentGuides: boolean;
  occurrenceHighlights: boolean;
}

/** A document as the host describes it. */
export interface DocumentSummary {
  id: number;
  path: string | null;
  title: string;
  dirty: boolean;
  /** How the file is indented; a host that does not say leaves it out. */
  indent?: IndentStyle;
}

/** What the host tells the service about its documents. */
export type DocumentEvent =
  | { type: "opened"; summary: DocumentSummary }
  | { type: "closed"; id: number }
  | { type: "dirty"; id: number; dirty: boolean }
  | { type: "saved"; id: number }
  | { type: "edited"; id: number }
  | { type: "syntax"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "selections"; id: number; row: number; column: number; count: number; selected: boolean }
  | { type: "mode"; pane: string; mode: string; pending: string; commandLine: string | null }
  | { type: "indent"; id: number; indent: IndentStyle }
  | { type: "close-request"; id: number; discard: boolean }
  | { type: "open-request"; id: number; path: string }
  | { type: "change-request"; id: number; forward: boolean }
  | { type: "notice"; message: string };

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
  /** Tells the host what the editor's settings say. A host that has nothing to configure leaves it out. */
  configure?(options: EditorOptions): Promise<void>;
  /** Makes a document of text that belongs to no file; `name`'s extension says what language it is. */
  openText(name: string, text: string): Promise<DocumentSummary>;
  /** The text of a document. */
  text(id: number): Promise<string>;
  /** Replaces the text of a document made by `openText`. */
  setText(id: number, text: string): Promise<void>;
  /** Reads a document's file from disk again, dropping its edits. */
  reload(id: number): Promise<void>;
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
  apply(command: { type: string; [field: string]: unknown }): Promise<{ changed: boolean }>;
  /** Draws the view again, such as after the decorations of its document changed. */
  refresh(): Promise<void>;
  /** Shows what the language server says about the symbol at the cursor. */
  hover(): Promise<void>;
  /** Goes to the definition of the symbol at the cursor. */
  definition(): Promise<void>;
  /** Opens the completion panel at the cursor. */
  complete(): Promise<void>;
  /** Lists where the symbol at the cursor is used. */
  references(): Promise<void>;
  /** Goes to the type of the symbol at the cursor. */
  typeDefinition(): Promise<void>;
  /** Goes to the implementations of the symbol at the cursor. */
  implementation(): Promise<void>;
  /** Asks for a new name for the symbol at the cursor and renames it everywhere. */
  rename(): Promise<void>;
  /** Lists the fixes and refactors the language server offers at the cursor. */
  codeActions(): Promise<void>;
  /** Shows the signature of the call the cursor is in. */
  signature(): Promise<void>;
  /** Formats the document. */
  format(): Promise<void>;
  /** Scrolls so the row under a pointer at this y in the window, over the minimap, is in the middle of the editor. */
  minimapScroll(windowY: number): Promise<void>;
  /** Puts the cursor at a line and UTF-16 column, counted from zero, and scrolls to it. */
  goto(line: number, character: number): Promise<void>;
  /**
   * Handles a right press at a point in window coordinates: the cursor moves there unless a
   * selection covers it. Answers whether text is selected afterwards. A view that has no menu,
   * such as a test's stand-in, leaves it out.
   */
  contextClick?(x: number, y: number): Promise<{ selected: boolean }>;
  /** Every selection, as the positions of its two ends. A view that cannot say, such as a test's stand-in, leaves it out. */
  selections?(): Promise<EditorSelection[]>;
}

/** A right press in an editor, where a menu of its actions is to open. */
export interface ContextMenuRequest {
  leafId: string;
  /** Where the pointer is, in window coordinates. */
  x: number;
  y: number;
  /** Whether text is selected, which cut and copy act on. */
  hasSelection: boolean;
}

/** A selection as the positions of its two ends, counted from zero; the ends are equal for a bare cursor. */
export interface EditorSelection {
  anchor: TextPosition;
  head: TextPosition;
}

/** A place to put the cursor once the document that has it is shown. */
export interface RevealRequest {
  documentId: number;
  line: number;
  character: number;
}

/** The methods of the editor element a command can call without an answer. */
export type ViewAction =
  | "hover"
  | "definition"
  | "complete"
  | "references"
  | "typeDefinition"
  | "implementation"
  | "rename"
  | "codeActions"
  | "signature"
  | "format";

/** An open document, as other plugins see it. */
export interface BufferInfo {
  id: number;
  path: string;
  title: string;
  dirty: boolean;
  /** How the file is indented, or null before the host has said. */
  indent: IndentStyle | null;
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
  /** `NORMAL`, `INSERT`, `VISUAL`, `V-LINE`, `V-BLOCK` or `REPLACE`; empty while the keys are the standard ones. */
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

/** What a pane hides when nothing asked it to; one array, so a view does not see a new value each time. */
const NO_SOURCES: string[] = [];

export class EditorService extends Service {
  private documentsById = new Map<number, BufferInfo>();
  private paneTabs = new Map<string, PaneTabs>();
  private viewsByLeaf = new Map<string, EditorViewMethods>();
  private cursorsById = new Map<number, CursorInfo>();
  /** The decoration sources a pane leaves out, by `leafId:documentId`. */
  private hiddenSources = new Map<string, string[]>();
  private promptState: Prompt | null = null;
  private answerClose: ((choice: CloseChoice) => void) | null = null;
  private messageText = "";
  private revealing: RevealRequest | null = null;
  private changes: ChangeSignal = createChangeSignal();
  private keymapName: KeymapName = "standard";
  private pendingSequence: () => boolean = () => false;
  private leaderBound: () => boolean = () => false;
  /** What each pane's vim layer last reported, by pane id. */
  private vimStates = new Map<string, VimStatus>();
  private documentListeners = new Set<(event: DocumentEvent) => void>();
  private contextMenuListeners = new Set<(request: ContextMenuRequest) => void>();

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
    this.openPath(path).catch((error) => this.setMessage(describeError(error)));
  }

  /** Like `open`, and resolves to the document's id once it is shown, or null when it could not be opened. */
  async openPath(path: string): Promise<number | null> {
    const shown = await this.openPathIn(path);
    if (shown === null) {
      return null;
    }
    return shown.documentId;
  }

  /**
   * Like `openPath`, and resolves to the pane that shows the document as well, or `leafId` null
   * when there is no editor pane to show it in. Null when the file could not be opened.
   */
  async openPathIn(path: string): Promise<{ documentId: number; leafId: string | null } | null> {
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
      return { documentId: summary.id, leafId: null };
    }
    this.showIn(leafId, summary.id, true);
    this.panes.focus(leafId);
    this.setMessage("");
    return { documentId: summary.id, leafId };
  }

  /**
   * Opens a file as a document without showing it in any pane, for a view that draws it itself,
   * such as a diff. Resolves to the document's id, or null when it could not be opened. Pair it
   * with `releaseDocument`.
   */
  async openDocument(path: string): Promise<number | null> {
    try {
      const summary = await this.host.open(path);
      this.adopt(summary);
      return summary.id;
    } catch (error) {
      this.setMessage(describeError(error));
      return null;
    }
  }

  /** Makes a document of text that belongs to no file. Resolves to its id, or null when that failed. */
  async openText(name: string, text: string): Promise<number | null> {
    try {
      const summary = await this.host.openText(name, text);
      this.adopt(summary);
      return summary.id;
    } catch (error) {
      this.setMessage(describeError(error));
      return null;
    }
  }

  /** The text of a document. */
  textOf(documentId: number): Promise<string> {
    return this.host.text(documentId);
  }

  /** Replaces the text of a document made by `openText`. */
  setText(documentId: number, text: string): Promise<void> {
    return this.host.setText(documentId, text);
  }

  /** Reads a document's file again, so what another program or a git command did to it shows. */
  async reloadDocument(documentId: number): Promise<void> {
    try {
      await this.host.reload(documentId);
    } catch (error) {
      this.setMessage(describeError(error));
    }
  }

  /**
   * Lets go of a document `openDocument` or `openText` made once the view that drew it is done.
   * A document no pane has a tab for is closed, unless it has unsaved changes: that one gets a
   * tab, so the changes are not lost out of sight.
   */
  async releaseDocument(documentId: number): Promise<void> {
    const info = this.documentsById.get(documentId);
    if (!info || this.isShownElsewhere(documentId, "")) {
      return;
    }
    const leafId = this.targetLeafId();
    if (info.dirty && leafId !== null) {
      this.showIn(leafId, documentId, false);
      return;
    }
    // Forgotten before the host is asked, so a second release meanwhile finds nothing to close.
    this.forget(documentId);
    await this.host.close(documentId);
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

  /** Where to ask whether the app's keymap is half way through a key sequence, such as after Ctrl+K. */
  setPendingSequenceSource(source: () => boolean): void {
    this.pendingSequence = source;
  }

  /** Where to ask whether any key binding starts with the leader key, which vim's normal mode then leaves to the keymap. */
  setLeaderKeySource(source: () => boolean): void {
    this.leaderBound = source;
  }

  /** Whether the editors leave a bare space in vim's normal mode to the keymap, because a binding starts with it. Reactive. */
  leaderKeyBound(): boolean {
    return this.leaderBound();
  }

  /**
   * Whether the app's keymap waits for the next key of a sequence. The editors then leave every key to
   * the keymap, since vim would otherwise take the `v` of Ctrl+K V. Reactive.
   */
  sequencePending(): boolean {
    return this.pendingSequence();
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
      this.vimStates.clear();
    }
    this.changes.notify();
  }

  /** The mode and pending keys of the focused pane's vim layer, empty until that pane has reported. Reactive. */
  vimStatus(): VimStatus {
    this.changes.track();
    const status = this.vimStates.get(this.panes.focusedLeafId);
    if (status === undefined) {
      return { mode: "", pending: "", commandLine: null };
    }
    return status;
  }

  /**
   * Whether a bare space may start a leader sequence now: the focused pane is an editor on vim's keys,
   * in normal mode with nothing half typed. In any other state the editor takes the space. Reactive.
   */
  acceptsLeaderKey(): boolean {
    if (this.keymap() !== "vim" || !this.hasFocusedView() || this.prompt() !== null) {
      return false;
    }
    const status = this.vimStatus();
    return status.mode === "NORMAL" && status.pending === "" && status.commandLine === null;
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

  /** Sends the focused pane's editor a command with fields, such as a cursor placed at a position. */
  async applyToFocused(command: { type: string; [field: string]: unknown }): Promise<void> {
    const view = this.viewsByLeaf.get(this.panes.focusedLeafId);
    if (!view) {
      throw new Error(`there is no editor to ${command.type} in`);
    }
    await view.apply(command);
  }

  /** Whether the focused pane has an editor to take a command. Reactive. */
  hasFocusedView(): boolean {
    this.changes.track();
    return this.viewsByLeaf.has(this.panes.focusedLeafId);
  }

  /** Sends the focused pane's editor one of its commands, such as `undo`, as its own keys would. */
  async sendCommand(type: string, fields: Record<string, unknown> = {}): Promise<void> {
    const view = this.viewsByLeaf.get(this.panes.focusedLeafId);
    if (!view) {
      throw new Error(`there is no editor to ${type} in`);
    }
    await view.apply({ ...fields, type });
  }

  /** Sets how the focused pane's file is indented, which its Tab, Enter and shifts follow. */
  setIndent(style: IndentStyle): Promise<void> {
    return this.sendCommand("set_indent", { style });
  }

  /** Passes the editor's settings on to the host, which the views follow from the next frame. */
  async configure(options: EditorOptions): Promise<void> {
    if (!this.host.configure) {
      return;
    }
    await this.host.configure(options);
    await this.refreshViews();
  }

  /** Asks the focused pane's editor to do something at its cursor, such as show a hover. */
  async actOnFocusedView(action: ViewAction): Promise<void> {
    const view = this.viewsByLeaf.get(this.panes.focusedLeafId);
    if (!view) {
      return;
    }
    await view[action]();
  }

  /**
   * Opens a file and puts the cursor at a line and UTF-16 column, counted from zero, as going to
   * a definition does. The cursor moves once the pane shows the file.
   */
  async reveal(path: string, line: number, character: number): Promise<void> {
    const documentId = await this.openPath(path);
    if (documentId === null) {
      return;
    }
    this.revealing = { documentId, line, character };
    this.changes.notify();
  }

  /** The cursor move that is waiting for its document to be shown, or null. Reactive. */
  pendingReveal(): RevealRequest | null {
    this.changes.track();
    return this.revealing;
  }

  /** Marks a cursor move as done, so it is not made again. */
  finishReveal(request: RevealRequest): void {
    if (this.revealing === request) {
      this.revealing = null;
    }
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
    await this.refreshViews();
    return true;
  }

  /**
   * Like `setDecorations`, for a document that may have no file or no pane, such as one side of
   * a diff. The views that show it are told to draw again.
   */
  async setDecorationsOf(documentId: number, source: string, decorations: Decoration[]): Promise<void> {
    await this.host.setDecorations(documentId, source, decorations);
    await this.refreshViews();
  }

  /** Asks every mounted editor to draw again. One that is being unmounted cannot, and that does not stop the others. */
  async refreshViews(): Promise<void> {
    const refreshes = [...this.viewsByLeaf.values()].map(async (view) => {
      try {
        await view.refresh();
      } catch (error) {
        this.ctx.logger.warn(`editor: could not redraw a view: ${describeError(error)}`);
      }
    });
    await Promise.all(refreshes);
  }

  /**
   * Sets which decoration sources a pane leaves out when it shows a document, such as the git bars
   * under a diff that draws its own. An empty list shows them again.
   */
  hideSources(leafId: string, documentId: number, sources: string[]): void {
    const key = `${leafId}:${documentId}`;
    if (sources.length === 0) {
      this.hiddenSources.delete(key);
    } else {
      this.hiddenSources.set(key, sources);
    }
    this.changes.notify();
  }

  /** The decoration sources a pane leaves out for a document. Reactive. */
  hiddenSourcesIn(leafId: string, documentId: number): string[] {
    this.changes.track();
    const sources = this.hiddenSources.get(`${leafId}:${documentId}`);
    if (sources === undefined) {
      return NO_SOURCES;
    }
    return sources;
  }

  /** The newest selection of a pane's editor, or null when the pane has none or cannot say. */
  async selectionOf(leafId: string): Promise<EditorSelection | null> {
    const view = this.viewsByLeaf.get(leafId);
    if (view === undefined || view.selections === undefined) {
      return null;
    }
    const selections = await view.selections();
    if (selections.length === 0) {
      return null;
    }
    return selections[selections.length - 1];
  }

  /** Gives a pane's editor the keyboard, such as after a field drawn over it is done. */
  focusView(leafId: string): void {
    const view = this.viewsByLeaf.get(leafId);
    if (view === undefined) {
      return;
    }
    // The element a pane mounts has `focus`; a test's stand-in may not.
    const focusable = view as { focus?: () => void };
    if (focusable.focus !== undefined) {
      focusable.focus();
    }
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

  /**
   * Handles a right press in a pane's editor: the pane takes the focus, the cursor goes to the
   * press unless a selection covers it, and whoever shows menus is told where to open one.
   */
  async openContextMenu(leafId: string, x: number, y: number): Promise<void> {
    const view = this.viewsByLeaf.get(leafId);
    if (!view || !view.contextClick) {
      return;
    }
    this.panes.focus(leafId);
    const { selected } = await view.contextClick(x, y);
    for (const listener of [...this.contextMenuListeners]) {
      listener({ leafId, x, y, hasSelection: selected });
    }
  }

  /** Hears of right presses in an editor, where a menu is to open. Returns the function that stops it. */
  onContextMenu(handler: (request: ContextMenuRequest) => void): () => void {
    this.contextMenuListeners.add(handler);
    return () => {
      this.contextMenuListeners.delete(handler);
    };
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
    let indent: IndentStyle | null = null;
    if (summary.indent !== undefined) {
      indent = summary.indent;
    }
    this.documentsById.set(summary.id, { id: summary.id, path, title: summary.title, dirty: summary.dirty, indent });
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
    this.dropHiddenSources((key) => key.endsWith(`:${documentId}`));
    this.changes.notify();
  }

  /** Forgets the hidden sources whose key a test picks out, for a document or a pane that is gone. */
  private dropHiddenSources(picks: (key: string) => boolean): void {
    for (const key of [...this.hiddenSources.keys()]) {
      if (picks(key)) {
        this.hiddenSources.delete(key);
      }
    }
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
    this.vimStates.delete(leafId);
    this.dropHiddenSources((key) => key.startsWith(`${leafId}:`));
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
    if (event.type === "edited") {
      return;
    }
    if (event.type === "syntax") {
      void this.refreshViews();
      return;
    }
    if (event.type === "error" || event.type === "notice") {
      this.setMessage(event.message);
      return;
    }
    if (event.type === "mode") {
      this.vimStates.set(event.pane, { mode: event.mode, pending: event.pending, commandLine: event.commandLine });
      this.changes.notify();
      return;
    }
    if (event.type === "indent") {
      this.setIndentOf(event.id, event.indent);
      return;
    }
    if (event.type === "close-request") {
      this.closeFromCommandLine(event.id, event.discard).catch((error) => this.setMessage(describeError(error)));
      return;
    }
    if (event.type === "open-request") {
      this.open(event.path);
      return;
    }
    if (event.type === "change-request") {
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

  /** Records how a document is indented. */
  private setIndentOf(documentId: number, indent: IndentStyle): void {
    const info = this.documentsById.get(documentId);
    if (!info) {
      return;
    }
    this.documentsById.set(documentId, { ...info, indent });
    this.changes.notify();
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
