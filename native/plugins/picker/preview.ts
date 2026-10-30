// What the picker's preview shows: a read-only copy of the file as a document of its own, so
// previewing never touches the cursor, the edits or the decorations of a tab that has the file
// open. The loader keeps one document at a time and drops it when the next arrives. Kept apart
// from the component so it runs under `bun test` with fakes.

import type { Decoration } from "@neoworks/svelte-gpui-editor";
import type { PreviewTarget } from "./service";

/** Files larger than this are not previewed: reading and highlighting them would stall the picker. */
export const MAX_PREVIEW_BYTES = 400_000;

/** The decoration source the match highlight uses. */
export const MATCH_SOURCE = "picker.match";

/** What the preview needs of the world. */
export interface PreviewHost {
  /** The size of a file in bytes. Rejects when it cannot be read. */
  sizeOf(path: string): Promise<number>;
  /** The text of a file. Rejects when it is not text. */
  readText(path: string): Promise<string>;
  /** Makes a document of text; `name`'s extension says what language it is. Null when that failed. */
  openText(name: string, text: string): Promise<number | null>;
  /** Lets go of a document made by `openText`. */
  release(documentId: number): Promise<void>;
  /** Replaces what one source has put on top of a document. */
  decorate(documentId: number, source: string, decorations: Decoration[]): Promise<void>;
}

/** What the preview area shows. */
export type PreviewState =
  | { kind: "empty" }
  | { kind: "notice"; message: string }
  | { kind: "document"; documentId: number; line: number; column: number };

export class PreviewLoader {
  private latest = 0;
  private shownId: number | null = null;
  private disposed = false;

  constructor(
    private host: PreviewHost,
    private onChange: (state: PreviewState) => void,
  ) {}

  /** Shows the target, or nothing for null. A newer request makes an older one that is still reading give up. */
  async show(target: PreviewTarget | null): Promise<void> {
    const request = this.latest + 1;
    this.latest = request;
    if (target === null) {
      this.publish({ kind: "empty" });
      return;
    }
    const prepared = await this.prepare(target);
    if (this.disposed || request !== this.latest) {
      await this.dropIfOpened(prepared);
      return;
    }
    await this.display(prepared, target, request);
  }

  /** Stops showing and lets go of the document. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.latest += 1;
    await this.release();
  }

  /** Reads the file into a document, or into the sentence that says why it cannot be shown. */
  private async prepare(target: PreviewTarget): Promise<Prepared> {
    try {
      const size = await this.host.sizeOf(target.path);
      if (size > MAX_PREVIEW_BYTES) {
        return { notice: "Too large to preview" };
      }
      const text = await this.host.readText(target.path);
      const documentId = await this.host.openText(baseName(target.path), text);
      if (documentId === null) {
        return { notice: "Cannot preview this file" };
      }
      return { documentId };
    } catch {
      return { notice: "Cannot preview this file" };
    }
  }

  /** Puts a prepared document on screen with the match marked, then drops the one it replaces. */
  private async display(prepared: Prepared, target: PreviewTarget, request: number): Promise<void> {
    if (prepared.documentId === undefined) {
      await this.release();
      let message = "";
      if (prepared.notice !== undefined) {
        message = prepared.notice;
      }
      this.publish({ kind: "notice", message });
      return;
    }
    await this.markMatch(prepared.documentId, target);
    if (this.disposed || request !== this.latest) {
      await this.dropIfOpened(prepared);
      return;
    }
    const replaced = this.shownId;
    this.shownId = prepared.documentId;
    this.publish({ kind: "document", documentId: prepared.documentId, line: target.line, column: target.column });
    if (replaced !== null) {
      await this.host.release(replaced);
    }
  }

  /** Highlights the matched text of the target, when the target has a range. */
  private async markMatch(documentId: number, target: PreviewTarget): Promise<void> {
    if (target.endColumn === undefined || target.endColumn <= target.column) {
      return;
    }
    const decoration: Decoration = {
      kind: "highlight",
      start: { row: target.line, column: target.column },
      end: { row: target.line, column: target.endColumn },
      background: "warning",
    };
    await this.host.decorate(documentId, MATCH_SOURCE, [decoration]);
  }

  /** Lets go of the document on screen. */
  private async release(): Promise<void> {
    const shown = this.shownId;
    this.shownId = null;
    this.publish({ kind: "empty" });
    if (shown !== null) {
      await this.host.release(shown);
    }
  }

  /** Lets go of a document that was opened for a request nobody wants any more. */
  private async dropIfOpened(prepared: Prepared): Promise<void> {
    if (prepared.documentId !== undefined) {
      await this.host.release(prepared.documentId);
    }
  }

  /** Tells the component what to draw, unless the loader has been disposed. */
  private publish(state: PreviewState): void {
    if (!this.disposed) {
      this.onChange(state);
    }
  }
}

/** The result of reading a file: a document, or the reason there is none. */
interface Prepared {
  documentId?: number;
  notice?: string;
}

/** The last segment of a path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return path.slice(slash + 1);
}
