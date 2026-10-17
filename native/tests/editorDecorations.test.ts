import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import { debugDecorations } from "../plugins/editor/debugDecorations";
import {
  EditorService,
  type Decoration,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
} from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { languageStubs } from "./support/viewStubs";

/** A host that records the decorations it is given, by document and source, as Rust would keep them. */
class RecordingHost implements DocumentHost {
  documents = new Map<string, DocumentSummary>();
  sets = new Map<string, Decoration[]>();
  order: string[] = [];
  private handlers: ((event: DocumentEvent) => void)[] = [];

  async open(path: string): Promise<DocumentSummary> {
    const existing = this.documents.get(path);
    if (existing) {
      return existing;
    }
    const summary = { id: this.documents.size + 1, path, title: path.split("/").pop() as string, dirty: false };
    this.documents.set(path, summary);
    return summary;
  }

  async close(): Promise<void> {}
  async save(): Promise<void> {}

  async setDecorations(id: number, source: string, decorations: Decoration[]): Promise<void> {
    this.order.push(`set ${id} ${source}`);
    if (decorations.length === 0) {
      this.sets.delete(`${id}/${source}`);
      return;
    }
    this.sets.set(`${id}/${source}`, decorations);
  }

  onEvent(handler: (event: DocumentEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  emit(event: DocumentEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

/** An editor service over a recording host. */
async function setUp(): Promise<{ host: RecordingHost; editor: EditorService; layout: LayoutService }> {
  const root = new RootContext();
  const host = new RecordingHost();
  let editor!: EditorService;
  let layout!: LayoutService;
  await root.plugin({
    name: "editor-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, host, layout);
    },
  });
  return { host, editor, layout };
}

const squiggle: Decoration = {
  kind: "highlight",
  start: { row: 1, column: 2 },
  end: { row: 1, column: 6 },
  underline: { style: "squiggle", tone: "error" },
};

describe("setting decorations", () => {
  test("a source's set goes to the document that has the file", async () => {
    const { host, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    await editor.openPath("/src/b.rs");
    expect(await editor.setDecorations("/src/b.rs", "lsp", [squiggle])).toBe(true);
    expect(host.sets.get("2/lsp")).toEqual([squiggle]);
    expect(host.sets.has("1/lsp")).toBe(false);
  });

  test("a file that is not open takes nothing and says so", async () => {
    const { host, editor } = await setUp();
    expect(await editor.setDecorations("/src/missing.rs", "lsp", [squiggle])).toBe(false);
    expect(host.order).toEqual([]);
  });

  test("sources have sets of their own, and an empty list removes one", async () => {
    const { host, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    await editor.setDecorations("/src/a.rs", "lsp", [squiggle]);
    await editor.setDecorations("/src/a.rs", "git", [{ kind: "gutter", start: { row: 0, column: 0 }, mark: "bar", tone: "added" }]);
    await editor.clearDecorations("/src/a.rs", "lsp");
    expect([...host.sets.keys()]).toEqual(["1/git"]);
  });

  test("every mounted view is asked to draw again once the set is in", async () => {
    const { host, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    const events: string[] = [];
    const view = (name: string) => ({
      ...languageStubs(),
      apply: async () => ({ changed: false }),
      refresh: async () => {
        events.push(`${name} refreshed after ${host.order.length} sets`);
      },
    });
    editor.registerView("left", view("left"));
    editor.registerView("right", view("right"));
    await editor.setDecorations("/src/a.rs", "lsp", [squiggle]);
    expect(events).toEqual(["left refreshed after 1 sets", "right refreshed after 1 sets"]);
  });
});

describe("document events", () => {
  test("a listener hears what the host reports, after the service has taken it in, until it stops", async () => {
    const { host, editor } = await setUp();
    const heard: string[] = [];
    const stop = editor.onDocumentEvent((event) => {
      heard.push(`${event.type} with ${editor.buffers().length} buffers`);
    });
    host.emit({ type: "opened", summary: { id: 1, path: "/a.rs", title: "a.rs", dirty: false } });
    stop();
    host.emit({ type: "saved", id: 1 });
    expect(heard).toEqual(["opened with 1 buffers"]);
  });
});

describe("the debug decorations", () => {
  test("have one of each kind, all at the cursor", () => {
    const decorations = debugDecorations({ row: 4, column: 7, count: 1, selected: false });
    const kinds = decorations.map((decoration) => decoration.kind);
    expect(kinds).toEqual(["highlight", "inlay", "line_end", "gutter", "block"]);
    for (const decoration of decorations) {
      expect(decoration.start.row).toBe(4);
    }
    expect(decorations[1].start.column).toBe(7);
  });
});
