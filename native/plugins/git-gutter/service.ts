// The `git-gutter` service: keeps two sets of decorations on every open file. The gutter bars
// (`git.changes`) show how the file differs from HEAD, and the text after the cursor's line
// (`git.blame`) says who last changed it. Both are read from git for the file on disk, so they
// refresh when a file is opened or saved; blame also follows the cursor.
//
// While a file has unsaved changes its line numbers no longer match what git sees, so blame is
// removed once the cursor moves and comes back on save. The bars stay, pinned to the text they
// were drawn for, and move with the edits.

import { Service, type Context } from "@neoworks/extension-system";
import type { DocumentEvent, EditorService } from "../editor/service";
import { BLAME_SOURCE, CHANGES_SOURCE, blameDecoration, changeDecorations } from "./changes";
import type { GitHost } from "./gitHost";

declare module "@neoworks/extension-system" {
  interface Context {
    gitGutter: GitGutterService;
  }
}

/** How long the cursor has to stay before blame is asked for, so holding an arrow key asks once. */
const BLAME_DELAY_MS = 120;

export interface GitGutterOptions {
  /** The time now in milliseconds, for "3 days ago". */
  now?: () => number;
  blameDelayMs?: number;
}

export class GitGutterService extends Service {
  private now: () => number;
  private blameDelayMs: number;
  /** The newest request for each file, so an answer that arrives late is dropped. */
  private requests = new Map<string, number>();
  private blameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextRequest = 0;

  constructor(
    ctx: Context,
    private editor: EditorService,
    private git: GitHost,
    options: GitGutterOptions = {},
  ) {
    super(ctx, "gitGutter");
    this.now = options.now ?? Date.now;
    this.blameDelayMs = options.blameDelayMs ?? BLAME_DELAY_MS;
    ctx.effect(() => this.editor.onDocumentEvent((event) => this.handle(event)), "git-gutter.documents");
    ctx.effect(() => () => this.cancelTimers(), "git-gutter.timers");
    for (const buffer of this.editor.buffers()) {
      this.background(this.refresh(buffer.id));
    }
  }

  /** Reads the changes and the blame of the cursor's line for a document, and shows them. */
  async refresh(documentId: number): Promise<void> {
    await Promise.all([this.showChanges(documentId), this.showBlame(documentId)]);
  }

  /** Reacts to something that happened to a document. */
  private handle(event: DocumentEvent): void {
    if (event.type === "opened") {
      this.background(this.refresh(event.summary.id));
      return;
    }
    if (event.type === "saved") {
      this.background(this.showChanges(event.id));
      return;
    }
    // The text matches the file again, after a save or an undo back to it, so what git says fits.
    if (event.type === "dirty" && !event.dirty) {
      this.background(this.refresh(event.id));
      return;
    }
    if (event.type === "selections") {
      this.scheduleBlame(event.id);
      return;
    }
    if (event.type === "closed") {
      this.forget(event.id);
    }
  }

  /** The path of an open document that has a file, or null. */
  private pathOf(documentId: number): string | null {
    const buffer = this.editor.buffers().find((candidate) => candidate.id === documentId);
    if (!buffer || buffer.path === "") {
      return null;
    }
    return buffer.path;
  }

  /** Replaces the gutter bars of a document with the current diff against HEAD. */
  private async showChanges(documentId: number): Promise<void> {
    const path = this.pathOf(documentId);
    if (path === null) {
      return;
    }
    const request = this.begin(path + "#changes");
    const changes = await this.git.fileChanges(path).catch(() => null);
    if (!this.isLatest(path + "#changes", request) || this.pathOf(documentId) === null) {
      return;
    }
    const hunks = changes === null ? [] : changes.hunks;
    await this.editor.setDecorations(path, CHANGES_SOURCE, changeDecorations(hunks));
  }

  /** Shows who last changed the line the cursor is on, or nothing when the file has unsaved changes. */
  private async showBlame(documentId: number): Promise<void> {
    const buffer = this.editor.buffers().find((candidate) => candidate.id === documentId);
    if (!buffer || buffer.path === "") {
      return;
    }
    const request = this.begin(buffer.path + "#blame");
    let row = 0;
    const cursor = this.editor.cursorOf(documentId);
    if (cursor) {
      row = cursor.row;
    }
    const blame = buffer.dirty ? null : await this.git.blameLine(buffer.path, row + 1).catch(() => null);
    if (!this.isLatest(buffer.path + "#blame", request) || this.pathOf(documentId) === null) {
      return;
    }
    if (blame === null) {
      await this.editor.setDecorations(buffer.path, BLAME_SOURCE, []);
      return;
    }
    await this.editor.setDecorations(buffer.path, BLAME_SOURCE, [blameDecoration(row, blame, this.now())]);
  }

  /** Asks for blame once the cursor has stopped moving for a moment. */
  private scheduleBlame(documentId: number): void {
    const pending = this.blameTimers.get(documentId);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    const timer = setTimeout(() => {
      this.blameTimers.delete(documentId);
      this.background(this.showBlame(documentId));
    }, this.blameDelayMs);
    this.blameTimers.set(documentId, timer);
  }

  /** Runs a refresh nobody waits for, and logs what it throws, such as a document that closed meanwhile. */
  private background(work: Promise<unknown>): void {
    work.catch((error) => this.ctx.logger.warn(`git-gutter: could not draw: ${String(error)}`));
  }

  /** Starts a request for a key and returns its number. */
  private begin(key: string): number {
    this.nextRequest += 1;
    this.requests.set(key, this.nextRequest);
    return this.nextRequest;
  }

  /** Whether no newer request for the key has started since this one. */
  private isLatest(key: string, request: number): boolean {
    return this.requests.get(key) === request;
  }

  /** Drops what is pending for a document that closed. */
  private forget(documentId: number): void {
    const timer = this.blameTimers.get(documentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.blameTimers.delete(documentId);
    }
  }

  /** Stops every pending blame request. */
  private cancelTimers(): void {
    for (const timer of this.blameTimers.values()) {
      clearTimeout(timer);
    }
    this.blameTimers.clear();
  }
}
