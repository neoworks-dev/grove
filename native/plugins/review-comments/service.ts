// The `reviewComments` service: comments on changed lines of the diff drawn over a file in an
// editor pane, kept per worktree on disk, drawn as blocks under their lines, and sent to the
// agent as one message. The service owns the data and the decorations; the widgets over the
// blocks (cards, the input) are drawn by `CommentLayer.svelte` from what `cardsAt` answers.
// State is plain fields with a change signal, never `$state`.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { DiffService, InlineEntry } from "../diff/service";
import type { Decoration, EditorService } from "../editor/service";
import {
  DRAFT_ROWS,
  cardRows,
  commentCount,
  commentId,
  commentableRows,
  commentsByRow,
  newComment,
  quoteRows,
  reanchorAll,
  reviewMessage,
  selectionRows,
  type ReviewComment,
  type RowRange,
} from "./model";
import type { CommentStore, WorktreeComments } from "./store";

declare module "@neoworks/extension-system" {
  interface Context {
    reviewComments: ReviewCommentsService;
  }
}

/** The key a block under a row is reported under. */
export function blockKey(row: number): string {
  return `row:${row}`;
}

/** The row a block key names, or null for a key that is not ours. */
export function rowOfBlockKey(key: string): number | null {
  if (!key.startsWith("row:")) {
    return null;
  }
  const row = Number(key.slice(4));
  if (!Number.isInteger(row)) {
    return null;
  }
  return row;
}

/** How long the offer to take a sent review back stays. */
const UNDO_WINDOW_MS = 30_000;

/** Where a review goes: which session, and how it gets there. */
export interface ReviewSender {
  /** The session a review of these files goes to, or null when there is none to send it to. */
  sessionFor(worktreePath: string, absolutePaths: readonly string[]): string | null;
  /** Sends the agent the review. `shown` is what the chat displays in place of `text`. */
  send(sessionId: string, text: string, shown: string): Promise<void>;
}

/** What the service needs to know about worktrees. */
export interface ReviewWorktrees {
  /** The root of every worktree that is open. */
  paths(): string[];
}

/** What the service needs of the layout. */
export interface ReviewPanes {
  readonly focusedLeafId: string;
}

/** The comment being written or edited. */
interface Draft {
  leafId: string;
  documentId: number;
  worktreePath: string;
  path: string;
  range: RowRange;
  quoted: string[];
  text: string;
  /** The comment this replaces, when an existing one is being edited. */
  editing: string | null;
}

/** One card hanging under a row: a saved comment, or the input. */
export type Card =
  | { kind: "comment"; id: string; rows: number; comment: ReviewComment }
  | { kind: "draft"; id: string; rows: number; range: RowRange; editing: boolean };

/** The comments a send took, which can be put back. */
interface SentReview {
  worktreePath: string;
  comments: ReviewComment[];
  count: number;
}

export class ReviewCommentsService extends Service {
  private byWorktree = new Map<string, ReviewComment[]>();
  private draft: Draft | null = null;
  private sent: SentReview | null = null;
  private sentTimer: ReturnType<typeof setTimeout> | undefined;
  private changes: ChangeSignal = createChangeSignal();
  /** The decorations last put on each pane's document, as text, so an unchanged drawing is not sent again. */
  private drawn = new Map<string, { documentId: number; source: string; json: string }>();
  /** How many lines each document had when its comments were last placed. */
  private lineCounts = new Map<number, number>();
  /** The work in progress, which the next piece waits for. */
  private working: Promise<void> = Promise.resolve();
  private sequence = 0;
  private loaded: Promise<void>;

  constructor(
    ctx: Context,
    private editor: EditorService,
    private diff: DiffService,
    private panes: ReviewPanes,
    private worktrees: ReviewWorktrees,
    private sender: ReviewSender,
    private store: CommentStore,
    private now: () => number = Date.now,
  ) {
    super(ctx, "reviewComments");
    this.loaded = this.load();
    ctx.effect(() => diff.onInlineChanged(() => this.enqueue(() => this.refresh())), "reviewComments.diffs");
    ctx.effect(() => () => clearTimeout(this.sentTimer), "reviewComments.timers");
  }

  /** Resolves once the comments saved in an earlier run are read. */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** The worktree a file is in: the one with the longest root that holds it, or null. */
  worktreeOf(absolutePath: string): string | null {
    let found: string | null = null;
    for (const root of this.worktrees.paths()) {
      const holds = absolutePath.startsWith(`${root}/`);
      if (holds && (found === null || root.length > found.length)) {
        found = root;
      }
    }
    return found;
  }

  /** Every comment of a worktree, in the order they were written. Reactive. */
  commentsIn(worktreePath: string): ReviewComment[] {
    this.changes.track();
    const comments = this.byWorktree.get(worktreePath);
    if (comments === undefined) {
      return [];
    }
    return comments;
  }

  /** The comments on one file, by its absolute path. Reactive. */
  commentsOnFile(absolutePath: string): ReviewComment[] {
    const worktreePath = this.worktreeOf(absolutePath);
    if (worktreePath === null) {
      return [];
    }
    const path = absolutePath.slice(worktreePath.length + 1);
    return this.commentsIn(worktreePath).filter((comment) => comment.path === path);
  }

  /** The rows of a document in a pane that can take a comment: the lines the diff changed or added. Reactive. */
  rowsFor(leafId: string, documentId: number): number[] {
    const shown = this.shownFile(leafId, documentId);
    if (shown === undefined) {
      return [];
    }
    return commentableRows(shown.hunks);
  }

  /** Whether the pane that has the focus shows a diff, so a comment can be started in it. Reactive. */
  canComment(): boolean {
    const leafId = this.panes.focusedLeafId;
    const active = this.editor.activeIn(leafId);
    if (active === null) {
      return false;
    }
    return this.shownFile(leafId, active.id) !== undefined;
  }

  /** How many comments the focused pane's worktree has, or 0 when it shows no diff. Reactive. */
  countForFocused(): number {
    const worktreePath = this.focusedWorktree();
    if (worktreePath === null) {
      return 0;
    }
    return this.commentsIn(worktreePath).length;
  }

  /** The worktree of the file the focused pane shows, or null. Reactive. */
  focusedWorktree(): string | null {
    const active = this.editor.activeIn(this.panes.focusedLeafId);
    if (active === null || active.path === "") {
      return null;
    }
    return this.worktreeOf(active.path);
  }

  /** The cards that hang under a row of a document in a pane, in order: saved comments, then the input. Reactive. */
  cardsAt(leafId: string, documentId: number, row: number): Card[] {
    this.changes.track();
    const shown = this.shownFile(leafId, documentId);
    if (shown === undefined) {
      return [];
    }
    const cards = this.cardsOfFile(shown).get(row);
    if (cards === undefined) {
      return [];
    }
    return cards;
  }

  /** The comment being written, as the input shows it: null while none is. Reactive. */
  draftText(): string {
    this.changes.track();
    if (this.draft === null) {
      return "";
    }
    return this.draft.text;
  }

  /** Whether an input is open, which takes the keys. Reactive. */
  isDrafting(): boolean {
    this.changes.track();
    if (this.draft === null) {
      return false;
    }
    return this.shownFile(this.draft.leafId, this.draft.documentId) !== undefined;
  }

  /** Starts a comment on the lines the focused pane's selection covers, or on the cursor's line. */
  async beginAtSelection(): Promise<void> {
    const leafId = this.panes.focusedLeafId;
    const active = this.editor.activeIn(leafId);
    if (active === null || this.shownFile(leafId, active.id) === undefined) {
      this.diff.tell("Show a file's changes to comment on them.");
      return;
    }
    const selection = await this.editor.selectionOf(leafId);
    if (selection !== null) {
      await this.beginOnRange(leafId, active.id, selectionRows(selection.anchor, selection.head));
      return;
    }
    const cursor = this.editor.cursorOf(active.id);
    if (cursor === null) {
      return;
    }
    await this.beginOnRange(leafId, active.id, { startRow: cursor.row, endRow: cursor.row });
  }

  /** Starts a comment on one line, as the gutter's "+" does. */
  beginOnRow(leafId: string, documentId: number, row: number): Promise<void> {
    return this.beginOnRange(leafId, documentId, { startRow: row, endRow: row });
  }

  /** Starts a comment on lines of a document, when the last of them is one the diff changed or added. */
  async beginOnRange(leafId: string, documentId: number, range: RowRange): Promise<void> {
    await this.loaded;
    const shown = this.shownFile(leafId, documentId);
    if (shown === undefined) {
      return;
    }
    if (!commentableRows(shown.hunks).includes(range.endRow)) {
      this.diff.tell("Put the cursor on a changed or added line to comment on it.");
      return;
    }
    const worktreePath = this.worktreeOf(shown.path);
    if (worktreePath === null) {
      this.diff.tell("This file is not in an open worktree, so there is nowhere to keep a comment on it.");
      return;
    }
    const lines = (await this.editor.textOf(documentId)).split("\n");
    this.draft = {
      leafId,
      documentId,
      worktreePath,
      path: shown.path.slice(worktreePath.length + 1),
      range,
      quoted: quoteRows(lines, range),
      text: "",
      editing: null,
    };
    this.changed();
  }

  /** Opens a saved comment in the input, to change what it says. */
  async edit(commentIdToEdit: string): Promise<void> {
    const found = this.find(commentIdToEdit);
    if (found === null) {
      return;
    }
    const shown = this.shownOf(found.worktreePath, found.comment);
    if (shown === undefined) {
      return;
    }
    this.draft = {
      leafId: shown.leafId,
      documentId: shown.documentId,
      worktreePath: found.worktreePath,
      path: found.comment.path,
      range: { startRow: found.comment.startRow, endRow: found.comment.endRow },
      quoted: found.comment.quoted,
      text: found.comment.text,
      editing: found.comment.id,
    };
    this.changed();
  }

  /** Remembers what the input says as it is typed. */
  setDraftText(text: string): void {
    if (this.draft === null) {
      return;
    }
    this.draft = { ...this.draft, text };
  }

  /** Saves the input as a comment, or as the new text of the comment it edits. Empty text saves nothing. */
  async saveDraft(): Promise<void> {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    const text = draft.text.trim();
    if (text === "") {
      this.cancelDraft();
      return;
    }
    const comments = [...this.commentsIn(draft.worktreePath)];
    const at = comments.findIndex((comment) => comment.id === draft.editing);
    if (at >= 0) {
      comments[at] = { ...comments[at], text };
    } else {
      this.sequence += 1;
      const id = commentId(this.now(), this.sequence);
      comments.push(newComment(id, draft.path, draft.range, draft.quoted, text, this.now()));
    }
    this.draft = null;
    this.sent = null;
    await this.setComments(draft.worktreePath, comments);
    this.editor.focusView(draft.leafId);
  }

  /** Closes the input without saving. */
  cancelDraft(): void {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    this.draft = null;
    this.changed();
    this.editor.focusView(draft.leafId);
  }

  /** Deletes a saved comment. */
  async remove(commentIdToRemove: string): Promise<void> {
    const found = this.find(commentIdToRemove);
    if (found === null) {
      return;
    }
    const kept = this.commentsIn(found.worktreePath).filter((comment) => comment.id !== commentIdToRemove);
    await this.setComments(found.worktreePath, kept);
  }

  /**
   * Sends every comment of a worktree to the agent as one message and clears them. Resolves to
   * whether it was sent; when it was not, the comments stay and the reason is told.
   */
  async send(worktreePath: string): Promise<boolean> {
    const comments = this.commentsIn(worktreePath);
    if (comments.length === 0) {
      return false;
    }
    const absolutePaths = comments.map((comment) => `${worktreePath}/${comment.path}`);
    const sessionId = this.sender.sessionFor(worktreePath, absolutePaths);
    if (sessionId === null) {
      this.diff.tell("There is no agent session to send the review to. Start one in this worktree first.");
      return false;
    }
    const message = reviewMessage(comments);
    try {
      await this.sender.send(sessionId, message.text, message.shown);
    } catch (error) {
      this.diff.tell(`Could not send the review: ${describeError(error)}`);
      return false;
    }
    this.sent = { worktreePath, comments: [...comments], count: comments.length };
    clearTimeout(this.sentTimer);
    this.sentTimer = setTimeout(() => this.forgetSent(), UNDO_WINDOW_MS);
    await this.setComments(worktreePath, []);
    return true;
  }

  /** What the last send took and may give back: its worktree and how many comments. Reactive. */
  lastSent(): { worktreePath: string; count: number } | null {
    this.changes.track();
    if (this.sent === null) {
      return null;
    }
    return { worktreePath: this.sent.worktreePath, count: this.sent.count };
  }

  /** Puts the comments of the last send back. The agent has already read them; this keeps them to edit or send again. */
  async undoSend(): Promise<void> {
    const sent = this.sent;
    if (sent === null) {
      return;
    }
    clearTimeout(this.sentTimer);
    this.sent = null;
    const kept = [...this.commentsIn(sent.worktreePath), ...sent.comments];
    await this.setComments(sent.worktreePath, kept);
  }

  /** The label of the review bar: how many comments there are. */
  countLabel(worktreePath: string): string {
    return commentCount(this.commentsIn(worktreePath).length);
  }

  /** Stops offering to take the last send back. */
  private forgetSent(): void {
    this.sent = null;
    this.changed();
  }

  /** Reads the comments saved in an earlier run. */
  private async load(): Promise<void> {
    let saved: WorktreeComments = {};
    try {
      saved = await this.store.load();
    } catch (error) {
      this.ctx.logger.warn(`review: could not read the saved comments: ${describeError(error)}`);
    }
    for (const [worktreePath, comments] of Object.entries(saved)) {
      this.byWorktree.set(worktreePath, comments);
    }
    this.changed();
  }

  /** Replaces a worktree's comments, writes them to disk and draws. */
  private async setComments(worktreePath: string, comments: ReviewComment[]): Promise<void> {
    if (comments.length === 0) {
      this.byWorktree.delete(worktreePath);
    } else {
      this.byWorktree.set(worktreePath, comments);
    }
    this.changed();
    await this.persist();
  }

  /** Writes every worktree's comments. A failure is logged, since the comments are still in memory. */
  private async persist(): Promise<void> {
    const everything: WorktreeComments = {};
    for (const [worktreePath, comments] of this.byWorktree) {
      everything[worktreePath] = comments;
    }
    try {
      await this.store.save(everything);
    } catch (error) {
      this.ctx.logger.warn(`review: could not save the comments: ${describeError(error)}`);
    }
  }

  /** Tells readers something changed and draws again. */
  private changed(): void {
    this.changes.notify();
    this.enqueue(() => this.sync());
  }

  /** Runs a piece of work after the one before it. */
  private enqueue(work: () => Promise<void>): void {
    this.working = this.working.then(work).catch((error) => {
      this.ctx.logger.warn(`review: ${describeError(error)}`);
    });
  }

  /** Finds a saved comment and the worktree it is in. */
  private find(id: string): { worktreePath: string; comment: ReviewComment } | null {
    for (const [worktreePath, comments] of this.byWorktree) {
      const comment = comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) {
        return { worktreePath, comment };
      }
    }
    return null;
  }

  /** The diff shown over a document in a pane, as this service reads it. Reactive. */
  private shownFile(leafId: string, documentId: number): InlineEntry | undefined {
    return this.diff.inlineViews().find((entry) => entry.leafId === leafId && entry.documentId === documentId);
  }

  /** The pane showing the diff a comment's file has, if any pane does. */
  private shownOf(worktreePath: string, comment: ReviewComment): InlineEntry | undefined {
    const absolutePath = `${worktreePath}/${comment.path}`;
    return this.diff.inlineViews().find((entry) => entry.path === absolutePath);
  }

  /** The cards of a file by the row they hang under, saved comments first, the input after them. */
  private cardsOfFile(shown: InlineEntry): Map<number, Card[]> {
    const worktreePath = this.worktreeOf(shown.path);
    const cards = new Map<number, Card[]>();
    if (worktreePath === null) {
      return cards;
    }
    const path = shown.path.slice(worktreePath.length + 1);
    const comments = this.commentsIn(worktreePath).filter((comment) => comment.path === path);
    const lastRow = this.lastRowOf(shown.documentId);
    const draft = this.draftFor(shown, path);
    for (const [row, there] of commentsByRow(comments)) {
      const onRow = Math.min(row, lastRow);
      for (const comment of there) {
        this.addCard(cards, onRow, this.cardOfComment(comment, draft));
      }
    }
    if (draft !== null && draft.editing === null) {
      const onRow = Math.min(draft.range.endRow, lastRow);
      this.addCard(cards, onRow, { kind: "draft", id: "draft", rows: DRAFT_ROWS, range: draft.range, editing: false });
    }
    return cards;
  }

  /** The card for a saved comment: the input when that is the one being edited. */
  private cardOfComment(comment: ReviewComment, draft: Draft | null): Card {
    if (draft !== null && draft.editing === comment.id) {
      return { kind: "draft", id: "draft", rows: DRAFT_ROWS, range: draft.range, editing: true };
    }
    return { kind: "comment", id: comment.id, rows: cardRows(comment), comment };
  }

  /** Puts a card in a row's list. */
  private addCard(cards: Map<number, Card[]>, row: number, card: Card): void {
    const there = cards.get(row);
    if (there === undefined) {
      cards.set(row, [card]);
      return;
    }
    there.push(card);
  }

  /** The input, when it is for this file in this pane. */
  private draftFor(shown: InlineEntry, path: string): Draft | null {
    const draft = this.draft;
    if (draft === null || draft.documentId !== shown.documentId || draft.leafId !== shown.leafId || draft.path !== path) {
      return null;
    }
    return draft;
  }

  /** The last row of a document, as far as is known. */
  private lastRowOf(documentId: number): number {
    const count = this.lineCounts.get(documentId);
    if (count === undefined) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(0, count - 1);
  }

  /** Places the comments of every file shown with a diff against its text as it is now, then draws. */
  private async refresh(): Promise<void> {
    await this.loaded;
    for (const shown of this.diff.inlineViews()) {
      await this.reanchorFile(shown);
    }
    await this.sync();
  }

  /** Moves the comments of one file to where their lines are now, and keeps the result when any moved. */
  private async reanchorFile(shown: InlineEntry): Promise<void> {
    const worktreePath = this.worktreeOf(shown.path);
    if (worktreePath === null) {
      return;
    }
    let text: string;
    try {
      text = await this.editor.textOf(shown.documentId);
    } catch {
      return;
    }
    const lines = text.split("\n");
    this.lineCounts.set(shown.documentId, lines.length);
    const path = shown.path.slice(worktreePath.length + 1);
    const all = this.commentsIn(worktreePath);
    const onFile = all.filter((comment) => comment.path === path);
    const placed = reanchorAll(onFile, lines);
    if (placed.every((comment, index) => comment === onFile[index])) {
      return;
    }
    const byId = new Map(placed.map((comment) => [comment.id, comment]));
    this.byWorktree.set(worktreePath, all.map((comment) => this.placedOr(byId, comment)));
    this.changes.notify();
    await this.persist();
  }

  /** A comment as it was placed, or as it is when it was not among those placed. */
  private placedOr(placed: Map<string, ReviewComment>, comment: ReviewComment): ReviewComment {
    const moved = placed.get(comment.id);
    if (moved === undefined) {
      return comment;
    }
    return moved;
  }

  /** Draws the blocks the cards sit in on every pane that shows a diff, and takes them off panes that stopped. */
  private async sync(): Promise<void> {
    this.dropStrandedDraft();
    const shownNow = this.diff.inlineViews();
    const stillShown = new Set<string>();
    for (const shown of shownNow) {
      const key = `${shown.leafId}:${shown.documentId}`;
      stillShown.add(key);
      await this.drawFile(key, shown);
    }
    for (const [key, drawn] of [...this.drawn]) {
      if (stillShown.has(key)) {
        continue;
      }
      this.drawn.delete(key);
      await this.editor.setDecorationsOf(drawn.documentId, drawn.source, []).catch(() => {});
    }
  }

  /** Closes the input when the diff it was written over is gone. */
  private dropStrandedDraft(): void {
    if (this.draft === null || this.shownFile(this.draft.leafId, this.draft.documentId) !== undefined) {
      return;
    }
    this.draft = null;
    this.changes.notify();
  }

  /** Puts a file's blocks on its document in a pane, unless they are what is there already. */
  private async drawFile(key: string, shown: InlineEntry): Promise<void> {
    const source = `view:${shown.leafId}:review`;
    const decorations = this.blocksOf(shown);
    const json = JSON.stringify(decorations);
    const before = this.drawn.get(key);
    if (before !== undefined && before.json === json) {
      return;
    }
    if (before === undefined && decorations.length === 0) {
      return;
    }
    this.drawn.set(key, { documentId: shown.documentId, source, json });
    await this.editor.setDecorationsOf(shown.documentId, source, decorations).catch((error) => {
      this.ctx.logger.warn(`review: could not draw the comments: ${describeError(error)}`);
    });
  }

  /** One block under each row that has cards, as tall as its cards together. */
  private blocksOf(shown: InlineEntry): Decoration[] {
    const blocks: Decoration[] = [];
    const rows = [...this.cardsOfFile(shown).entries()].sort((first, second) => first[0] - second[0]);
    for (const [row, cards] of rows) {
      const height = cards.reduce((total, card) => total + card.rows, 0);
      blocks.push({
        kind: "block",
        start: { row, column: 0 },
        placement: "below",
        lines: new Array<string>(height).fill(""),
        tone: "filler",
        key: blockKey(row),
      });
    }
    return blocks;
  }
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
