// A stand-in for the native host's documents and diff commands, so the diff and git changes
// services run under `bun test`. Documents are held in memory, and every call is recorded.

import type { Decoration, DocumentEvent, DocumentHost, DocumentSummary } from "../../plugins/editor/service";
import type { BaseText, DiffHost, GitBase } from "../../plugins/diff/diffHost";
import type { Hunk } from "../../plugins/diff/model";

/** Documents the host keeps: files by path, and text that belongs to no file. */
export class FakeDocuments implements DocumentHost {
  summaries = new Map<number, DocumentSummary>();
  texts = new Map<number, string>();
  closed: number[] = [];
  decorations = new Map<string, Decoration[]>();
  files = new Map<string, string>();
  private handlers: ((event: DocumentEvent) => void)[] = [];
  private nextId = 1;

  async open(path: string): Promise<DocumentSummary> {
    for (const summary of this.summaries.values()) {
      if (summary.path === path) {
        return summary;
      }
    }
    const text = this.files.get(path);
    if (text === undefined) {
      throw new Error(`could not open ${path}`);
    }
    return this.add({ path, title: path.split("/").pop() as string }, text);
  }

  async openText(name: string, text: string): Promise<DocumentSummary> {
    return this.add({ path: null, title: name }, text);
  }

  /** Fails as the host does for a document that is not open, or was closed. */
  private requireOpen(id: number): void {
    if (!this.summaries.has(id)) {
      throw new Error(`document ${id} is not open`);
    }
  }

  async text(id: number): Promise<string> {
    this.requireOpen(id);
    return this.texts.get(id) ?? "";
  }

  async setText(id: number, text: string): Promise<void> {
    this.requireOpen(id);
    this.texts.set(id, text);
    this.emit({ type: "edited", id });
  }

  async reload(): Promise<void> {}

  async close(id: number): Promise<void> {
    this.requireOpen(id);
    this.summaries.delete(id);
    this.closed.push(id);
    this.emit({ type: "closed", id });
  }

  async save(): Promise<void> {}

  async setDecorations(id: number, source: string, decorations: Decoration[]): Promise<void> {
    this.requireOpen(id);
    this.decorations.set(`${id}/${source}`, decorations);
  }

  onEvent(handler: (event: DocumentEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  /** Makes a document and tells the listeners, as the host does. */
  private add(parts: { path: string | null; title: string }, text: string): DocumentSummary {
    const summary = { id: this.nextId, path: parts.path, title: parts.title, dirty: false };
    this.nextId += 1;
    this.summaries.set(summary.id, summary);
    this.texts.set(summary.id, text);
    this.emit({ type: "opened", summary });
    return summary;
  }

  /** Delivers an event as the host would. */
  emit(event: DocumentEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

/** The diff commands, answering from the texts git is said to have. */
export class FakeDiffHost implements DiffHost {
  head = new Map<string, string>();
  index = new Map<string, string>();
  found: Hunk[] = [];
  calls: string[] = [];
  /** The decoration source of each `apply`, in order. */
  sources: string[] = [];
  failWith: string | null = null;
  /** While set, `apply` waits for it, so a test can do something while a drawing is in flight. */
  gate: Promise<void> | null = null;
  /** The documents `apply` was asked to draw on that were not open then. */
  drawnOnClosed: number[] = [];
  /** Tells whether a document is open, for `apply` to notice one that is not. */
  isOpen: (id: number) => boolean = () => true;
  discarded: { path: string; untracked: boolean }[][] = [];

  async apply(options: { newId: number; oldId?: number; oldText: string; mode: "inline" | "split"; source: string }): Promise<Hunk[]> {
    for (const id of [options.newId, options.oldId]) {
      if (id !== undefined && !this.isOpen(id)) {
        this.drawnOnClosed.push(id);
        throw new Error(`document ${id} is not open`);
      }
    }
    if (this.gate !== null) {
      await this.gate;
    }
    this.sources.push(options.source);
    this.calls.push(`apply ${options.mode} new=${options.newId} old=${options.oldId === undefined ? "-" : options.oldId} "${options.oldText}"`);
    return this.found;
  }

  async hunks(): Promise<Hunk[]> {
    return this.found;
  }

  async preview(id: number, oldText: string, row: number, source: string): Promise<boolean> {
    this.calls.push(`preview ${id} row=${row} ${source}`);
    return true;
  }

  async stageHunk(id: number, row: number): Promise<void> {
    this.calls.push(`stage ${id} row=${row}`);
    this.fail();
  }

  async unstageHunk(path: string, row: number): Promise<void> {
    this.calls.push(`unstage ${path} row=${row}`);
    this.fail();
  }

  async revertHunk(id: number, base: GitBase, row: number): Promise<void> {
    this.calls.push(`revert ${id} ${base} row=${row}`);
    this.fail();
  }

  async baseText(path: string, base: GitBase): Promise<BaseText> {
    const source = base === "head" ? this.head : this.index;
    const text = source.get(path);
    if (text === undefined) {
      return { exists: false, text: "" };
    }
    return { exists: true, text };
  }

  async discard(files: { path: string; untracked: boolean }[]): Promise<void> {
    this.discarded.push(files);
  }

  /** Throws what `failWith` says, for an action that is to fail. */
  private fail(): void {
    if (this.failWith !== null) {
      throw new Error(this.failWith);
    }
  }
}
