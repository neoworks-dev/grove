// A diff as a tab of an ordinary editor pane: the same editor, showing the file's own document (or,
// for two texts, a document that belongs to no file) with the difference put on it as decorations
// that belong to that pane's diff tab alone. The file's own tab and other panes stay as they were,
// and the git bars that the diff replaces are left out of the diff tab. The old text is HEAD, the
// index or a text a caller names, and it is read again when the file changes on disk or something
// is staged. The diff goes when its tab closes.
//
// Two diffs of a file cannot show the file's own document: the staged changes, whose new side is
// the index, and a file that is gone. Those show a document of the new text that belongs to no file.

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
  /** The git base the hunk actions can read again, or null when the old side is a text or the diff is of the staged changes. */
  gitBase: GitBase | null;
  /** Whether it is the staged changes, the index against HEAD, whose hunks can be unstaged. */
  staged: boolean;
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
  base: DiffBase;
  oldText: string;
  /** The text the tab's document was made with when it belongs to no file; null for a file's own document. */
  newText: string | null;
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
   * Shows how a file differs from a base in a diff tab of an editor pane. The tab shows the file's
   * own document, except for the staged changes and a file that is gone. Resolves to false when
   * there is no editor pane to show it in, or nothing to show.
   */
  async show(path: string, base: DiffBase): Promise<boolean> {
    if (base === "staged") {
      return (await this.showStaged(path)) !== null;
    }
    const documentId = await this.editor.openDocument(path);
    if (documentId === null) {
      return (await this.showGone(path, base)) !== null;
    }
    return (await this.showDocument(documentId, path, base, null)) !== null;
  }

  /**
   * Shows how a text differs from an old one in a diff tab: the new text is a document that
   * belongs to no file, and `name`'s extension says what language it is. The same two texts shown
   * again reuse that document. Resolves to the tab, or null when there is no editor pane to show it in.
   */
  showTexts(name: string, oldText: string, newText: string, label: string): Promise<DiffTab | null> {
    return this.showDetached(name, { text: oldText, label }, newText);
  }

  /** Shows the staged changes of a file: the index's text, against HEAD. */
  private async showStaged(path: string): Promise<DiffTab | null> {
    let index: string;
    try {
      index = (await this.host.baseText(path, "index")).text;
    } catch (error) {
      this.hooks.say(describeError(error));
      return null;
    }
    return this.showDetached(path, "staged", index);
  }

  /** Shows a file that cannot be opened, as a deleted one cannot, as nothing against its base. Null when the base has no such file either. */
  private async showGone(path: string, base: DiffBase): Promise<DiffTab | null> {
    const gitBase = gitBaseOf(base);
    if (gitBase === null) {
      return this.showDetached(path, base, "");
    }
    try {
      const known = await this.host.baseText(path, gitBase);
      if (!known.exists) {
        return null;
      }
    } catch {
      return null;
    }
    return this.showDetached(path, base, "");
  }

  /** Shows a diff whose new side is a text that belongs to no file, in the document an earlier showing of it made, else a new one. */
  private async showDetached(path: string, base: DiffBase, newText: string): Promise<DiffTab | null> {
    const known = this.findDetached(path, base, newText);
    let documentId: number | null;
    if (known === undefined) {
      documentId = await this.editor.openText(lastSegment(path), newText);
    } else {
      documentId = known.documentId;
    }
    if (documentId === null) {
      return null;
    }
    return this.showDocument(documentId, path, base, newText);
  }

  /** The overlay whose document has the new side of this diff. A staged diff's text is read again anyway, so only its path has to match. */
  private findDetached(path: string, base: DiffBase, newText: string): Overlay | undefined {
    for (const overlay of this.overlays.values()) {
      if (overlay.newText === null || overlay.path !== path || !sameBase(overlay.base, base)) {
        continue;
      }
      if (base === "staged" || overlay.newText === newText) {
        return overlay;
      }
    }
    return undefined;
  }

  /** Gives a document a diff tab and draws its changes there. Resolves to the tab, or null when it could not be shown. */
  private async showDocument(documentId: number, path: string, base: DiffBase, newText: string | null): Promise<DiffTab | null> {
    const leafId = this.editor.showDiffTab(documentId);
    if (leafId === null) {
      return null;
    }
    const key = keyOf(leafId, documentId);
    const known = this.overlays.get(key);
    const overlay = this.makeOverlay(leafId, documentId, path, base, newText);
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
    const staged = overlay.base === "staged";
    let label = baseLabel(overlay.base);
    if (staged) {
      label = baseLabel("head");
    }
    // Hunks are staged and reverted on the file's own document, which a gone file has not.
    let gitBase: GitBase | null = null;
    if (overlay.newText === null) {
      gitBase = gitBaseOf(overlay.base);
    }
    return { path: overlay.path, baseLabel: label, hunks: overlay.hunks, gitBase, staged, mode: overlay.mode };
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
  private makeOverlay(leafId: string, documentId: number, path: string, base: DiffBase, newText: string | null): Overlay {
    return {
      leafId,
      documentId,
      path,
      base,
      oldText: "",
      newText,
      hunks: [],
      mode: this.hooks.mode(),
      oldId: null,
      oldIdText: "",
      drawing: Promise.resolve(),
      generation: 0,
      reapplyTimer: undefined,
    };
  }

  /** Reads the old text of an overlay from its base, and the index's text into a staged diff's document. */
  private async read(overlay: Overlay): Promise<void> {
    this.nextGeneration += 1;
    const generation = this.nextGeneration;
    overlay.generation = generation;
    if (overlay.base === "staged") {
      await this.readIndex(overlay, generation);
    }
    const oldText = await this.oldTextOf(overlay.path, overlay.base);
    if (overlay.generation === generation) {
      overlay.oldText = oldText;
    }
  }

  /** Puts the index's text of a staged diff's file into its document, when it changed. */
  private async readIndex(overlay: Overlay, generation: number): Promise<void> {
    const index = await this.host.baseText(overlay.path, "index");
    if (overlay.generation !== generation || index.text === overlay.newText) {
      return;
    }
    overlay.newText = index.text;
    await this.editor.setText(overlay.documentId, index.text);
  }

  /** The old text a base names: HEAD for the staged changes. */
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

/** Whether two bases name the same old side. */
function sameBase(first: DiffBase, second: DiffBase): boolean {
  if (typeof first === "string" || typeof second === "string") {
    return first === second;
  }
  return first.text === second.text && first.label === second.label;
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
