// The `terminal` service: which terminals exist, where they are shown and what their tabs say.
//
// The shells themselves, their screens and their input are in Rust (`src/terminal/`); this keeps
// only a list. A terminal is shown in the bottom panel, where it belongs to the worktree that was
// selected when it was opened, or in a pane of the main area, where the pane's state names it. The
// view shows a terminal by its id, and the Rust side starts the shell the first time a view with a
// size shows it, so a terminal that is never shown never starts a shell.

import { Service, type Context } from "@neoworks/extension-system";
import type { Worktree } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { SplitDirection } from "../layout/layoutTree";

declare module "@neoworks/extension-system" {
  interface Context {
    terminal: TerminalService;
  }
}

/** The pane type of a terminal, the key of its entry in the `main` slot. */
export const TERMINAL_PANE_TYPE = "terminal";

/** The key of the terminal's tab in the bottom panel. */
export const TERMINAL_PANEL_TAB = "terminal";

/** What a tab says before the shell or its program has named itself. */
const DEFAULT_TITLE = "shell";

/** One terminal as the tabs and panes show it. */
export interface TerminalInfo {
  id: string;
  /** The directory the shell was started in. */
  cwd: string;
  title: string;
  /** The worktree the terminal was opened for; empty when no repository was open. */
  worktreeId: string;
  /** The pane that shows it, or null for a terminal of the bottom panel. */
  leafId: string | null;
  /** The shell ended and nothing has replaced it yet. */
  exited: boolean;
  /** A program rang the bell while the terminal was out of sight. */
  bell: boolean;
}

/** Something that happened in a terminal. */
export type TerminalEvent =
  | { type: "title"; id: string; title: string }
  | { type: "bell"; id: string }
  | { type: "exit"; id: string; code: number | null };

/** What the service asks of the Rust host. */
export interface TerminalHost {
  /** Ends a terminal's shell. */
  kill(id: string): Promise<void>;
  /** The directory a terminal's shell is in now, or null when it cannot be read. */
  workingDirectory(id: string): Promise<string | null>;
  /** Hears of titles, bells and exits; returns the function that stops. */
  onEvent(handler: (event: TerminalEvent) => void): () => void;
}

/** The part of the workspace the service reads: where new terminals start. */
export interface TerminalWorkspace {
  selectedWorktree(): Worktree | null;
}

/** The part of the bottom panel the service drives. */
export interface TerminalPanel {
  isOpen(): boolean;
  activeId(): string;
  open(): void;
  close(): void;
  select(tabId: string): void;
}

/** The part of the layout the service drives. */
export interface TerminalLayout {
  leafCount(): number;
  leafIds(): string[];
  paneTypeOf(leafId: string): string | undefined;
  paneState(leafId: string): Record<string, unknown>;
  setPaneState(leafId: string, patch: Record<string, unknown>): void;
  splitFocused(direction: SplitDirection, paneTypeId?: string): void;
  closeLeaf(leafId: string): void;
  focus(leafId: string): void;
  onPaneClosed(listener: (leafId: string) => void): () => void;
}

/** The part of the editor the service opens files with. */
export interface TerminalEditor {
  reveal(path: string, line: number, character: number): Promise<void>;
  openPath(path: string): Promise<number | null>;
}

/** The editor's pane type, which a file opened from a terminal must be shown in. */
const EDITOR_PANE_TYPE = "editor";

export class TerminalService extends Service {
  private terminals = new Map<string, TerminalInfo>();
  /** The tab shown in the panel for each worktree, by worktree id. */
  private activeByWorktree: Record<string, string> = {};
  private focusTarget: string | null = null;
  private counter = 0;
  private changes: ChangeSignal = createChangeSignal();

  constructor(
    ctx: Context,
    private host: TerminalHost,
    private workspace: TerminalWorkspace,
    private panel: TerminalPanel,
    private layout: TerminalLayout,
    private editor: TerminalEditor,
  ) {
    super(ctx, "terminal");
    ctx.effect(() => this.host.onEvent((event) => this.handle(event)), "terminal.events");
    ctx.effect(
      () => this.layout.onPaneClosed((leafId) => this.forgetPane(leafId)),
      "terminal.paneClosed",
    );
  }

  // ── What is open ────────────────────────────────────────────────

  /** The terminals of the bottom panel that belong to the selected worktree, in the order they were opened. Reactive. */
  panelTerminals(): TerminalInfo[] {
    this.changes.track();
    const worktreeId = this.selectedWorktreeId();
    return [...this.terminals.values()].filter((info) => info.leafId === null && info.worktreeId === worktreeId);
  }

  /** The terminal the panel shows: the one last chosen for the selected worktree, else its first. Reactive. */
  activePanelTerminal(): TerminalInfo | null {
    const open = this.panelTerminals();
    if (open.length === 0) {
      return null;
    }
    const chosen = this.activeByWorktree[this.selectedWorktreeId()];
    const found = open.find((info) => info.id === chosen);
    if (found) {
      return found;
    }
    return open[0];
  }

  /** The terminal a pane shows, or null while it has none. Reactive. */
  paneTerminal(leafId: string): TerminalInfo | null {
    this.changes.track();
    const terminalId = this.layout.paneState(leafId).terminalId;
    if (typeof terminalId !== "string") {
      return null;
    }
    const found = this.terminals.get(terminalId);
    if (!found) {
      return null;
    }
    return found;
  }

  /** The text of a pane's header: the terminal's title. */
  paneTitle(leafId: string): string {
    const info = this.paneTerminal(leafId);
    if (info === null) {
      return "Terminal";
    }
    return info.title;
  }

  /** A terminal by id. Reactive. */
  terminal(id: string): TerminalInfo | null {
    this.changes.track();
    const found = this.terminals.get(id);
    if (!found) {
      return null;
    }
    return found;
  }

  // ── Opening and closing ─────────────────────────────────────────

  /** Opens a terminal in the bottom panel for the selected worktree and shows it. Resolves to its id. */
  newPanelTerminal(): string {
    const info = this.create(null);
    this.activeByWorktree[info.worktreeId] = info.id;
    this.revealPanel(info.id);
    return info.id;
  }

  /** Splits the focused pane and shows a new terminal in the new half. */
  openInPane(direction: SplitDirection): void {
    this.layout.splitFocused(direction, TERMINAL_PANE_TYPE);
  }

  /**
   * Gives a pane a terminal if it has none, and replaces one whose shell ended with a fresh
   * one when `replaceExited` is set. The pane calls this when it appears.
   */
  ensurePaneTerminal(leafId: string, replaceExited = false): TerminalInfo {
    const existing = this.paneTerminal(leafId);
    if (existing !== null && !(replaceExited && existing.exited)) {
      return existing;
    }
    if (existing !== null) {
      this.remove(existing.id);
    }
    const info = this.create(leafId);
    this.layout.setPaneState(leafId, { terminalId: info.id });
    return info;
  }

  /** Shows or hides the panel's terminal, opening one if there is none. */
  togglePanel(): void {
    if (this.terminalTabShowing()) {
      this.panel.close();
      return;
    }
    this.showPanel();
  }

  /** Opens the panel on the terminal tab, with a terminal for the selected worktree, and focuses it. */
  showPanel(): void {
    const active = this.activePanelTerminal();
    if (active === null) {
      this.newPanelTerminal();
      return;
    }
    this.revealPanel(active.id);
  }

  /** Makes a terminal the one the panel shows. */
  selectPanelTerminal(id: string): void {
    const info = this.terminals.get(id);
    if (!info) {
      return;
    }
    this.activeByWorktree[info.worktreeId] = id;
    this.revealPanel(id);
  }

  /** Ends a terminal: its shell is hung up and its tab or pane content goes. */
  close(id: string): void {
    const info = this.terminals.get(id);
    if (!info) {
      return;
    }
    const wasInPanel = info.leafId === null;
    this.remove(id);
    if (wasInPanel && this.panelTerminals().length === 0 && this.terminalTabShowing()) {
      this.panel.close();
    }
  }

  // ── What the view asks for ──────────────────────────────────────

  /** The terminal that wants the keyboard, if one does. Reactive. */
  focusRequest(): string | null {
    this.changes.track();
    return this.focusTarget;
  }

  /** Asks for the keyboard to go to a terminal, once its view exists. */
  requestFocus(id: string): void {
    if (this.focusTarget === id || !this.terminals.has(id)) {
      return;
    }
    this.focusTarget = id;
    this.changes.notify();
  }

  /** The view took the keyboard for a terminal. */
  focusDone(id: string): void {
    if (this.focusTarget !== id) {
      return;
    }
    this.focusTarget = null;
    this.changes.notify();
  }

  /** Clears the mark a bell left on a terminal's tab. */
  seen(id: string): void {
    const info = this.terminals.get(id);
    if (!info || !info.bell) {
      return;
    }
    info.bell = false;
    this.changes.notify();
  }

  /** Opens a file a terminal printed, in an editor pane, with the cursor on a line and column counted from one. */
  async openFile(path: string, line: number | null, column: number | null): Promise<void> {
    const editorLeaf = this.layout.leafIds().find((leafId) => this.layout.paneTypeOf(leafId) === EDITOR_PANE_TYPE);
    if (editorLeaf !== undefined) {
      this.layout.focus(editorLeaf);
    }
    if (line === null) {
      await this.editor.openPath(path);
      return;
    }
    let character = 0;
    if (column !== null) {
      character = Math.max(0, column - 1);
    }
    await this.editor.reveal(path, Math.max(0, line - 1), character);
  }

  /** The directory a terminal's shell is in now, for opening another beside it. */
  async directoryOf(id: string): Promise<string | null> {
    return this.host.workingDirectory(id);
  }

  // ── Inside ──────────────────────────────────────────────────────

  /** The id of the selected worktree, or an empty string while none is. */
  private selectedWorktreeId(): string {
    const worktree = this.workspace.selectedWorktree();
    if (worktree === null) {
      return "";
    }
    return worktree.id;
  }

  /** A new terminal for the selected worktree, in a pane or in the panel. */
  private create(leafId: string | null): TerminalInfo {
    this.counter += 1;
    const worktree = this.workspace.selectedWorktree();
    let cwd = "";
    let worktreeId = "";
    if (worktree !== null) {
      cwd = worktree.path;
      worktreeId = worktree.id;
    }
    const info: TerminalInfo = {
      id: `terminal-${this.counter}`,
      cwd,
      title: DEFAULT_TITLE,
      worktreeId,
      leafId,
      exited: false,
      bell: false,
    };
    this.terminals.set(info.id, info);
    this.changes.notify();
    return info;
  }

  /** Forgets a terminal and hangs up its shell. */
  private remove(id: string): void {
    const info = this.terminals.get(id);
    if (!info) {
      return;
    }
    this.terminals.delete(id);
    if (this.activeByWorktree[info.worktreeId] === id) {
      delete this.activeByWorktree[info.worktreeId];
    }
    if (this.focusTarget === id) {
      this.focusTarget = null;
    }
    this.changes.notify();
    this.host.kill(id).catch((error) => this.ctx.logger.warn(`terminal: could not end ${id}: ${String(error)}`));
  }

  /** Opens the panel on the terminal tab and asks for the keyboard to go to a terminal. */
  private revealPanel(id: string): void {
    this.panel.open();
    this.panel.select(TERMINAL_PANEL_TAB);
    const info = this.terminals.get(id);
    if (info) {
      info.bell = false;
    }
    this.focusTarget = id;
    this.changes.notify();
  }

  /** Whether the panel is open on the terminal tab. */
  private terminalTabShowing(): boolean {
    if (!this.panel.isOpen()) {
      return false;
    }
    const tab = this.panel.activeId();
    return tab === TERMINAL_PANEL_TAB || tab === "";
  }

  /** A pane closed: its terminal goes with it. */
  private forgetPane(leafId: string): void {
    for (const info of [...this.terminals.values()]) {
      if (info.leafId === leafId) {
        this.remove(info.id);
      }
    }
  }

  /** Applies something the host reported. */
  private handle(event: TerminalEvent): void {
    const info = this.terminals.get(event.id);
    if (!info) {
      return;
    }
    if (event.type === "title") {
      info.title = event.title;
      this.changes.notify();
      return;
    }
    if (event.type === "bell") {
      this.markBell(info);
      return;
    }
    this.shellEnded(info);
  }

  /** A bell rang: mark the tab unless the terminal is the one in front of the person. */
  private markBell(info: TerminalInfo): void {
    if (info.leafId === null && this.terminalTabShowing() && this.activePanelTerminal()?.id === info.id) {
      return;
    }
    info.bell = true;
    this.changes.notify();
  }

  /** The shell ended: its tab closes, and so does its pane unless it is the only one. */
  private shellEnded(info: TerminalInfo): void {
    if (info.leafId === null) {
      this.close(info.id);
      return;
    }
    if (this.layout.leafCount() > 1) {
      this.layout.closeLeaf(info.leafId);
      return;
    }
    info.exited = true;
    this.changes.notify();
  }
}
