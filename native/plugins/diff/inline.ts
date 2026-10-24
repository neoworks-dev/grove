// A diff drawn over a file in an ordinary editor pane, instead of in a pane of its own. The
// difference is put on the file's own document as decorations that belong to that pane alone, so
// the same file in another pane stays as it was, and the git bars that the diff replaces are left
// out of the pane while it shows. The old text is HEAD, the index or a text a caller names, and it
// is read again when the file changes on disk or something is staged.

import type { EditorService } from "../editor/service";
import type { DiffHost, GitBase } from "./diffHost";
import { baseLabel, type DiffBase, type Hunk } from "./model";

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
}

/** What the inline diffs need from the editor. */
type InlineEditor = Pick<EditorService, "openPathIn" | "hideSources" | "setDecorationsOf" | "refreshViews">;

/** What the inline diffs tell the service that owns them. */
export interface InlineHooks {
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
    const shown = await this.editor.openPathIn(path);
    if (shown === null || shown.leafId === null) {
      return false;
    }
    const base = drawnBase(wanted);
    const key = keyOf(shown.leafId, shown.documentId);
    const known = this.overlays.get(key);
    if (known !== undefined) {
      clearTimeout(known.reapplyTimer);
    }
    const overlay = this.makeOverlay(shown.leafId, shown.documentId, path, base);
    this.overlays.set(key, overlay);
    this.editor.hideSources(shown.leafId, shown.documentId, REPLACED_SOURCES);
    try {
      await this.read(overlay);
    } catch (error) {
      await this.hide(shown.leafId, shown.documentId);
      this.hooks.say(describeError(error));
      return false;
    }
    await this.draw(overlay);
    return true;
  }

  /** Takes the diff off a pane's document. */
  async hide(leafId: string, documentId: number): Promise<void> {
    const key = keyOf(leafId, documentId);
    const overlay = this.overlays.get(key);
    if (overlay === undefined) {
      return;
    }
    clearTimeout(overlay.reapplyTimer);
    this.overlays.delete(key);
    this.editor.hideSources(leafId, documentId, []);
    this.hooks.changed();
    try {
      await this.editor.setDecorationsOf(documentId, sourceOf(leafId), []);
    } catch (error) {
      this.hooks.warn(`diff: could not take a diff off document ${documentId}: ${describeError(error)}`);
    }
  }

  /** The diff a pane shows over a document, or undefined. */
  viewOf(leafId: string, documentId: number): InlineView | undefined {
    const overlay = this.overlays.get(keyOf(leafId, documentId));
    if (overlay === undefined) {
      return undefined;
    }
    return { path: overlay.path, baseLabel: baseLabel(overlay.base), hunks: overlay.hunks, gitBase: gitBaseOf(overlay.base) };
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

  /** A document closed: the diffs over it go with it. */
  onDocumentClosed(documentId: number): void {
    for (const overlay of [...this.overlays.values()]) {
      if (overlay.documentId === documentId) {
        clearTimeout(overlay.reapplyTimer);
        this.overlays.delete(keyOf(overlay.leafId, overlay.documentId));
      }
    }
    this.hooks.changed();
  }

  /** A pane closed: the diffs it showed go with it. */
  onPaneClosed(leafId: string): void {
    for (const overlay of [...this.overlays.values()]) {
      if (overlay.leafId === leafId) {
        clearTimeout(overlay.reapplyTimer);
        this.overlays.delete(keyOf(overlay.leafId, overlay.documentId));
      }
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
    const hunks = await this.host.apply({
      newId: overlay.documentId,
      oldText: overlay.oldText,
      mode: "inline",
      source: sourceOf(overlay.leafId),
    });
    if (!this.isCurrent(overlay)) {
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

/** The name a pane's diff decorations are drawn under. It belongs to the pane alone. */
function sourceOf(leafId: string): string {
  return `view:${leafId}:diff`;
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
