// A diff as a tab of an ordinary editor pane: the same editor, showing the file's own document (or,
// for two texts, a document that belongs to no file) with the difference put on it as decorations
// that belong to that pane's diff tab alone. The file's own tab and other panes stay as they were,
// and the git bars that the diff replaces are left out of the diff tab. The old text is HEAD, the
// index or a text a caller names, and it is read again when the file changes on disk or something
// is staged. The diff goes when its tab closes.

import { viewIdOf, type EditorService } from "../editor/service";
import type { DiffHost, GitBase } from "./diffHost";
import { baseLabel, type DiffBase, type DiffMode, type Hunk } from "./model";

/** How long edits are gathered before the difference is worked out again. */
const REAPPLY_DELAY_MS = 120;

/** The decoration sources a pane leaves out while it shows a diff: the git bars, which the diff draws itself. */
const REPLACED_SOURCES = ["git.changes"];

/** What a pane that shows a diff over a document tells the person. */
export interface InlineView {
  path: string;
  /** What the old side is called: "HEAD", "Index" or what a caller named it. */
  baseLabel: string;
  hunks: Hunk[];
  /** The git base the hunk actions can read again, or null when the old side is a text. */
  gitBase: GitBase | null;
  /** Inline, or side by side with the old text left of the document. */
  mode: DiffMode;
}

/** A diff drawn over a file in a pane: which pane and document, and what it found. */
export interface InlineEntry {
  leafId: string;
  documentId: number;
  path: string;
  hunks: Hunk[];
}

/** A diff tab: the pane it is in and the document it shows. */
export interface DiffTab {
  leafId: string;
  documentId: number;
}

/** What the inline diffs need from the editor. */
type InlineEditor = Pick<
  EditorService,
  "openDocument" | "openText" | "setText" | "releaseDocument" | "showDiffTab" | "hideSources" | "setCompanion" | "setDecorationsOf" | "refreshViews"
>;

/** What the inline diffs ask of and tell the service that owns them. */
export interface InlineHooks {
  /** The mode a new diff tab starts in, as the settings say. */
  mode(): DiffMode;
  /** Something a view reads changed. */
  changed(): void;
  /** A sentence for the person. */
  say(text: string): void;
  /** Something went wrong that nobody is waiting on. */
  warn(message: string): void;
}

/** One pane's diff over one document. */
interface Overlay {
  leafId: string;
  documentId: number;
  path: string;
  /** A base that is never `staged`, which the inline diff draws as HEAD. */
  base: DiffBase;
  oldText: string;
  hunks: Hunk[];
  mode: DiffMode;
  /** The document of the old text, which the tab draws beside the document in split mode; null inline. */
  oldId: number | null;
  /** The old text that document has, so it is only written again when the old text changed. */
  oldIdText: string;
  /** The drawing in progress, which the next one waits for. */
  drawing: Promise<void>;
  /** The newest reading of the old text, so one that is overtaken drops what it read. */
  generation: number;
  reapplyTimer: ReturnType<typeof setTimeout> | undefined;
}

export class InlineDiffs {
  private overlays = new Map<string, Overlay>();
  private nextGeneration = 0;

  constructor(
    private editor: InlineEditor,
    private host: DiffHost,
    private hooks: InlineHooks,
  ) {}

  /**
   * Shows how a file differs from a base in an editor pane: the file is opened there if it is not,
   * and its changes are drawn over it. Resolves to false when there is no editor pane to show it in
   * or the file cannot be read, which leaves it to the caller to show the diff another way.
   */
  async show(path: string, wanted: DiffBase): Promise<boolean> {
    const documentId = await this.editor.openDocument(path);
    if (documentId === null) {
      return false;
    }
    return (await this.showDocument(documentId, path, drawnBase(wanted))) !== null;
  }

  /**
   * Shows how a text differs from an old one in a diff tab: the new text is a document that
   * belongs to no file, and `name`'s extension says what language it is. Resolves to the tab, or
   * null when there is no editor pane to show it in.
   */
  async showTexts(name: string, oldText: string, newText: string, label: string): Promise<DiffTab | null> {
    const documentId = await this.editor.openText(name, newText);
    if (documentId === null) {
      return null;
    }
    return this.showDocument(documentId, name, { text: oldText, label });
  }

  /** Gives a document a diff tab and draws its changes there. Resolves to the tab, or null when it could not be shown. */
  private async showDocument(documentId: number, path: string, base: DiffBase): Promise<DiffTab | null> {
    const leafId = this.editor.showDiffTab(documentId);
    if (leafId === null) {
      return null;
    }
    const key = keyOf(leafId, documentId);
    const known = this.overlays.get(key);
    const overlay = this.makeOverlay(leafId, documentId, path, base);
    if (known !== undefined) {
      // The tab shows the new base in the mode it was in, with the old side's document it had.
      clearTimeout(known.reapplyTimer);
      overlay.mode = known.mode;
      overlay.oldId = known.oldId;
      overlay.oldIdText = known.oldIdText;
    }
    this.overlays.set(key, overlay);
    this.editor.hideSources(leafId, documentId, REPLACED_SOURCES, "diff");
    try {
      await this.read(overlay);
    } catch (error) {
      await this.hide(leafId, documentId);
      this.hooks.say(describeError(error));
      return null;
    }
    await this.draw(overlay);
    return { leafId, documentId };
  }

  /** Takes the diff off a pane's document, once its diff tab is gone. */
  async hide(leafId: string, documentId: number): Promise<void> {
    const key = keyOf(leafId, documentId);
    const overlay = this.overlays.get(key);
    if (overlay === undefined) {
      return;
    }
    clearTimeout(overlay.reapplyTimer);
    this.overlays.delete(key);
    this.hooks.changed();
    await this.releaseOldSide(overlay);
    try {
      await this.editor.setDecorationsOf(documentId, sourceOf(leafId), []);
    } catch (error) {
      this.hooks.warn(`diff: could not take a diff off document ${documentId}: ${describeError(error)}`);
    }
  }

  /** Shows a pane's diff of a document inline or side by side. */
  async setMode(leafId: string, documentId: number, mode: DiffMode): Promise<void> {
    const overlay = this.overlays.get(keyOf(leafId, documentId));
    if (overlay === undefined || overlay.mode === mode) {
      return;
    }
    overlay.mode = mode;
    this.hooks.changed();
    await this.draw(overlay);
  }

  /** Closes the document of an overlay's old side, which only side by side has. */
  private async releaseOldSide(overlay: Overlay): Promise<void> {
    const oldId = overlay.oldId;
    if (oldId === null) {
      return;
    }
    overlay.oldId = null;
    overlay.oldIdText = "";
    this.editor.setCompanion(overlay.leafId, overlay.documentId, null);
    try {
      await this.editor.releaseDocument(oldId);
    } catch (error) {
      this.hooks.warn(`diff: could not close the old side's document: ${describeError(error)}`);
    }
  }

  /** Gives an overlay the document of its old text for side by side, with the text it has now. Resolves to its id, or null when it could not be made. */
  private async oldSideOf(overlay: Overlay): Promise<number | null> {
    if (overlay.oldId === null) {
      overlay.oldId = await this.editor.openText(lastSegment(overlay.path), overlay.oldText);
      overlay.oldIdText = overlay.oldText;
    }
    if (overlay.oldId !== null && overlay.oldIdText !== overlay.oldText) {
      await this.editor.setText(overlay.oldId, overlay.oldText);
      overlay.oldIdText = overlay.oldText;
    }
    if (overlay.oldId !== null) {
      this.editor.setCompanion(overlay.leafId, overlay.documentId, overlay.oldId);
    }
    return overlay.oldId;
  }

  /** Every diff drawn over a file in a pane, with the file it is of and the changes found. */
  entries(): InlineEntry[] {
    return [...this.overlays.values()].map((overlay) => ({
      leafId: overlay.leafId,
      documentId: overlay.documentId,
      path: overlay.path,
      hunks: overlay.hunks,
    }));
  }

  /** The diff a pane shows over a document, or undefined. */
  viewOf(leafId: string, documentId: number): InlineView | undefined {
    const overlay = this.overlays.get(keyOf(leafId, documentId));
    if (overlay === undefined) {
      return undefined;
    }
    return { path: overlay.path, baseLabel: baseLabel(overlay.base), hunks: overlay.hunks, gitBase: gitBaseOf(overlay.base), mode: overlay.mode };
  }

  /** Works the difference out again after the document's text changed, once the edits stop. */
  onEdited(documentId: number): void {
    for (const overlay of this.overlays.values()) {
      if (overlay.documentId !== documentId) {
        continue;
      }
      clearTimeout(overlay.reapplyTimer);
      overlay.reapplyTimer = setTimeout(() => this.redraw(overlay), REAPPLY_DELAY_MS);
    }
  }

  /** A document closed: the diffs over it go with it, and so do their old sides' documents. */
  onDocumentClosed(documentId: number): void {
    this.drop((overlay) => overlay.documentId === documentId);
  }

  /** A pane closed: the diffs it showed go with it, and so do their old sides' documents. */
  onPaneClosed(leafId: string): void {
    this.drop((overlay) => overlay.leafId === leafId);
  }

  /** Forgets the overlays a test picks out, closing their old sides' documents. */
  private drop(picks: (overlay: Overlay) => boolean): void {
    for (const overlay of [...this.overlays.values()]) {
      if (!picks(overlay)) {
        continue;
      }
      clearTimeout(overlay.reapplyTimer);
      this.overlays.delete(keyOf(overlay.leafId, overlay.documentId));
      void this.releaseOldSide(overlay);
    }
    this.hooks.changed();
  }

  /** Reads the git side of every diff again, such as after a commit or after something was staged. */
  async reloadAll(): Promise<void> {
    await Promise.all([...this.overlays.values()].map((overlay) => this.reload(overlay)));
  }

  /** Stops the timers that are pending. */
  cancelTimers(): void {
    for (const overlay of this.overlays.values()) {
      clearTimeout(overlay.reapplyTimer);
    }
  }

  /** A new overlay, with nothing read yet. */
  private makeOverlay(leafId: string, documentId: number, path: string, base: DiffBase): Overlay {
    return {
      leafId,
      documentId,
      path,
      base,
      oldText: "",
      hunks: [],
      mode: this.hooks.mode(),
      oldId: null,
      oldIdText: "",
      drawing: Promise.resolve(),
      generation: 0,
      reapplyTimer: undefined,
    };
  }

  /** Reads the old text of an overlay from its base. */
  private async read(overlay: Overlay): Promise<void> {
    this.nextGeneration += 1;
    const generation = this.nextGeneration;
    overlay.generation = generation;
    const oldText = await this.oldTextOf(overlay.path, overlay.base);
    if (overlay.generation === generation) {
      overlay.oldText = oldText;
    }
  }

  /** The old text a base names. */
  private async oldTextOf(path: string, base: DiffBase): Promise<string> {
    if (typeof base === "object") {
      return base.text;
    }
    if (base === "index") {
      return (await this.host.baseText(path, "index")).text;
    }
    return (await this.host.baseText(path, "head")).text;
  }

  /** Reads the old text again and draws. A failure is logged, since nobody waits on this. */
  private async reload(overlay: Overlay): Promise<void> {
    if (!this.isCurrent(overlay)) {
      return;
    }
    try {
      await this.read(overlay);
    } catch (error) {
      this.hooks.warn(`diff: could not read ${overlay.path} again: ${describeError(error)}`);
      return;
    }
    await this.draw(overlay);
  }

  /** Draws again after edits, logging a failure. */
  private redraw(overlay: Overlay): void {
    this.draw(overlay).catch((error) => this.hooks.warn(`diff: could not draw the changes: ${describeError(error)}`));
  }

  /** Draws the difference on the overlay's document. One drawing of an overlay runs at a time. */
  private draw(overlay: Overlay): Promise<void> {
    const drawing = overlay.drawing.then(() => this.drawNow(overlay));
    overlay.drawing = drawing.catch(() => {});
    return drawing;
  }

  /** One drawing: stops when the overlay is gone, since its document may be too. */
  private async drawNow(overlay: Overlay): Promise<void> {
    if (!this.isCurrent(overlay)) {
      return;
    }
    const options = { newId: overlay.documentId, oldText: overlay.oldText, source: sourceOf(overlay.leafId) };
    let hunks: Hunk[];
    if (overlay.mode === "split") {
      const oldId = await this.oldSideOf(overlay);
      if (oldId === null) {
        return;
      }
      hunks = await this.host.apply({ ...options, oldId, mode: "split" });
    } else {
      await this.releaseOldSide(overlay);
      hunks = await this.host.apply({ ...options, mode: "inline" });
    }
    if (!this.isCurrent(overlay)) {
      // The tab went while this drew; an old side made meanwhile goes with it.
      await this.releaseOldSide(overlay);
      return;
    }
    overlay.hunks = hunks;
    this.hooks.changed();
    await this.editor.refreshViews();
  }

  /** Whether the overlay is still the one its pane has for its document. */
  private isCurrent(overlay: Overlay): boolean {
    return this.overlays.get(keyOf(overlay.leafId, overlay.documentId)) === overlay;
  }
}

/** Names an overlay by its pane and document. */
function keyOf(leafId: string, documentId: number): string {
  return `${leafId}:${documentId}`;
}

/** The last part of a path, which names the old side's document and picks its language. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The name a pane's diff decorations are drawn under. It belongs to the pane's diff tab alone. */
function sourceOf(leafId: string): string {
  return `view:${viewIdOf(leafId, "diff")}:diff`;
}

/** The base an inline diff draws: the staged diff is the index against HEAD, which the file itself cannot show, so HEAD stands in. */
function drawnBase(base: DiffBase): DiffBase {
  if (base === "staged") {
    return "head";
  }
  return base;
}

/** The git base an overlay's old side is, when it is one. */
function gitBaseOf(base: DiffBase): GitBase | null {
  if (base === "head" || base === "index") {
    return base;
  }
  return null;
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
