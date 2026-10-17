// The `breadcrumbs` service: for every open document, the scopes the cursor is in. It asks the
// host once the cursor has rested, or the text has changed and then settled, so holding an arrow
// key or typing asks once. State is plain fields with a change signal, never `$state` (see the
// grove-plugins skill).

import { Service, type Context } from "@neoworks/extension-system";
import type { DocumentEvent, EditorService } from "../editor/service";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { Scope } from "./model";
import type { ScopeHost } from "./scopeHost";

declare module "@neoworks/extension-system" {
  interface Context {
    breadcrumbs: BreadcrumbsService;
  }
}

/** How long the cursor or the text has to rest before the scopes are asked for. */
const REST_DELAY_MS = 80;

export interface BreadcrumbsOptions {
  restDelayMs?: number;
}

export class BreadcrumbsService extends Service {
  private restDelayMs: number;
  private scopesByDocument = new Map<number, Scope[]>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** The newest request for each document, so an answer that arrives late is dropped. */
  private requests = new Map<number, number>();
  private nextRequest = 0;
  private changes: ChangeSignal = createChangeSignal();

  constructor(
    ctx: Context,
    private editor: EditorService,
    private host: ScopeHost,
    options: BreadcrumbsOptions = {},
  ) {
    super(ctx, "breadcrumbs");
    this.restDelayMs = options.restDelayMs ?? REST_DELAY_MS;
    ctx.effect(() => this.editor.onDocumentEvent((event) => this.handle(event)), "breadcrumbs.documents");
    ctx.effect(() => () => this.cancelTimers(), "breadcrumbs.timers");
    for (const buffer of this.editor.buffers()) {
      this.schedule(buffer.id);
    }
  }

  /** The scopes the cursor of a document is in, outermost first. Reactive. */
  scopesOf(documentId: number): Scope[] {
    this.changes.track();
    const scopes = this.scopesByDocument.get(documentId);
    if (scopes === undefined) {
      return [];
    }
    return scopes;
  }

  /** Reacts to something that happened to a document. */
  private handle(event: DocumentEvent): void {
    if (event.type === "closed") {
      this.forget(event.id);
      return;
    }
    if (event.type === "opened") {
      this.schedule(event.summary.id);
      return;
    }
    if (event.type === "selections" || event.type === "edited") {
      this.schedule(event.id);
    }
  }

  /** Asks for a document's scopes once its cursor and text have stopped changing for a moment. */
  private schedule(documentId: number): void {
    const pending = this.timers.get(documentId);
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    const timer = setTimeout(() => {
      this.timers.delete(documentId);
      this.refresh(documentId).catch((error) => this.ctx.logger.warn(`breadcrumbs: could not read scopes: ${String(error)}`));
    }, this.restDelayMs);
    this.timers.set(documentId, timer);
  }

  /** Reads the scopes at a document's cursor and keeps them if no newer read has started. */
  private async refresh(documentId: number): Promise<void> {
    let row = 0;
    let column = 0;
    const cursor = this.editor.cursorOf(documentId);
    if (cursor) {
      row = cursor.row;
      column = cursor.column;
    }
    this.nextRequest += 1;
    const request = this.nextRequest;
    this.requests.set(documentId, request);
    const scopes = await this.host.scopesAt(documentId, row, column);
    if (this.requests.get(documentId) !== request) {
      return;
    }
    this.scopesByDocument.set(documentId, scopes);
    this.changes.notify();
  }

  /** Drops what is kept for a document that closed. */
  private forget(documentId: number): void {
    const pending = this.timers.get(documentId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(documentId);
    }
    this.requests.delete(documentId);
    this.scopesByDocument.delete(documentId);
    this.changes.notify();
  }

  /** Stops every pending read. */
  private cancelTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
