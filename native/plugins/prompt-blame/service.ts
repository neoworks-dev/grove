// The `promptBlame` service: when the cursor rests on a line an agent wrote, the commit and the
// prompt behind it appear at the end of the line. Lines a person wrote get nothing, and the text
// goes as soon as the cursor moves or the text is edited.
//
// It shares the end of the line with git-gutter's blame. Where an agent wrote the line this
// text wins, and says the commit as well, so nothing git-gutter shows is lost; anywhere else
// git-gutter's text is what the line shows.

import { Service, type Context } from "@neoworks/extension-system";
import type { Worktree } from "../../../src/shared/types";
import type { DocumentEvent, EditorService } from "../editor/service";
import { END_OF_LINE } from "../git-gutter/changes";
import type { PromptBlameHost } from "./blameHost";
import { PROMPT_BLAME_SOURCE, promptLabel } from "./label";

declare module "@neoworks/extension-system" {
  interface Context {
    promptBlame: PromptBlameService;
  }
}

/** How long the cursor has to rest on a line before the prompt behind it is looked up. */
const REST_DELAY_MS = 400;

/** The part of the workspace prompt blame needs: which worktree the files belong to. */
export interface BlameWorkspace {
  selectedWorktree(): Pick<Worktree, "id" | "path"> | null;
}

export interface PromptBlameOptions {
  /** The time now in milliseconds, for "3 days ago". */
  now?: () => number;
  restDelayMs?: number;
}

export class PromptBlameService extends Service {
  private now: () => number;
  private restDelayMs: number;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The newest lookup for each document, so an answer for a cursor that has moved is dropped. */
  private requests = new Map<number, number>();
  private nextRequest = 0;
  /** The documents that have the text on one of their lines now. */
  private shownIn = new Set<number>();

  constructor(
    ctx: Context,
    private editor: EditorService,
    private host: PromptBlameHost,
    private workspace: BlameWorkspace,
    options: PromptBlameOptions = {},
  ) {
    super(ctx, "promptBlame");
    this.now = options.now ?? Date.now;
    this.restDelayMs = options.restDelayMs ?? REST_DELAY_MS;
    ctx.effect(() => this.editor.onDocumentEvent((event) => this.handle(event)), "prompt-blame.documents");
    ctx.effect(() => () => this.cancelTimers(), "prompt-blame.timers");
  }

  /** Reacts to something that happened to a document. */
  private handle(event: DocumentEvent): void {
    if (event.type === "closed") {
      this.forget(event.id);
      return;
    }
    if (event.type === "selections" || event.type === "edited") {
      this.cursorMoved(event.id);
      return;
    }
    if (event.type === "opened") {
      this.schedule(event.summary.id);
    }
  }

  /** The cursor moved or the text changed: the text goes, and a lookup starts once the cursor rests. */
  private cursorMoved(documentId: number): void {
    this.invalidate(documentId);
    this.clear(documentId);
    this.schedule(documentId);
  }

  /** Looks the line up once the cursor has rested on it. */
  private schedule(documentId: number): void {
    const pending = this.timers.get(documentId);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    const timer = setTimeout(() => {
      this.timers.delete(documentId);
      this.show(documentId).catch((error) => this.ctx.logger.warn(`prompt-blame: could not show: ${String(error)}`));
    }, this.restDelayMs);
    this.timers.set(documentId, timer);
  }

  /** Puts the prompt behind the cursor's line at its end, if an agent wrote the line. */
  private async show(documentId: number): Promise<void> {
    const buffer = this.editor.buffers().find((candidate) => candidate.id === documentId);
    const worktree = this.workspace.selectedWorktree();
    if (!buffer || buffer.path === "" || buffer.dirty || worktree === null) {
      return;
    }
    if (!buffer.path.startsWith(`${worktree.path}/`) || this.isTyping()) {
      return;
    }
    const cursor = this.editor.cursorOf(documentId);
    const row = cursor === null ? 0 : cursor.row;
    const request = this.invalidate(documentId);
    const text = (await this.editor.textOf(documentId)).split("\n")[row];
    if (text === undefined) {
      return;
    }
    const blame = await this.host.blameLine(worktree.id, buffer.path, row + 1, text).catch(() => null);
    if (blame === null || this.requests.get(documentId) !== request) {
      return;
    }
    const label = promptLabel(blame, this.now());
    if (label === null) {
      return;
    }
    const decoration = { kind: "line_end" as const, start: { row, column: END_OF_LINE }, text: label, tone: "line_end" as const };
    this.shownIn.add(documentId);
    await this.editor.setDecorations(buffer.path, PROMPT_BLAME_SOURCE, [decoration]);
  }

  /** Whether the person is typing, when the line is not the one that is on disk anyway. */
  private isTyping(): boolean {
    const mode = this.editor.vimStatus().mode;
    return mode === "INSERT" || mode === "REPLACE";
  }

  /** Makes any lookup that is under way out of date. Returns the number of the next one. */
  private invalidate(documentId: number): number {
    this.nextRequest += 1;
    this.requests.set(documentId, this.nextRequest);
    return this.nextRequest;
  }

  /** Takes the text off the line it is on, if it is on one. */
  private clear(documentId: number): void {
    if (!this.shownIn.delete(documentId)) {
      return;
    }
    const buffer = this.editor.buffers().find((candidate) => candidate.id === documentId);
    if (!buffer || buffer.path === "") {
      return;
    }
    this.editor
      .clearDecorations(buffer.path, PROMPT_BLAME_SOURCE)
      .catch((error) => this.ctx.logger.warn(`prompt-blame: could not clear: ${String(error)}`));
  }

  /** Drops what is pending for a document that closed. */
  private forget(documentId: number): void {
    const pending = this.timers.get(documentId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(documentId);
    }
    this.requests.delete(documentId);
    this.shownIn.delete(documentId);
  }

  /** Stops every pending lookup. */
  private cancelTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
