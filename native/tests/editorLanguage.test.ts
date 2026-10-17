import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import {
  EditorService,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
  type EditorViewMethods,
} from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";

/** A host with one document per path, which is all opening needs. */
class PathHost implements DocumentHost {
  documents = new Map<string, DocumentSummary>();

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
  async setDecorations(): Promise<void> {}

  onEvent(_handler: (event: DocumentEvent) => void): () => void {
    return () => {};
  }
}

/** A view that records the calls the language commands make on it. */
function recordingView(calls: string[]): EditorViewMethods {
  return {
    apply: async () => ({ changed: false }),
    refresh: async () => {},
    hover: async () => void calls.push("hover"),
    definition: async () => void calls.push("definition"),
    complete: async () => void calls.push("complete"),
    references: async () => void calls.push("references"),
    typeDefinition: async () => void calls.push("typeDefinition"),
    implementation: async () => void calls.push("implementation"),
    rename: async () => void calls.push("rename"),
    codeActions: async () => void calls.push("codeActions"),
    signature: async () => void calls.push("signature"),
    format: async () => void calls.push("format"),
    goto: async (line, character) => void calls.push(`goto ${line}:${character}`),
  };
}

async function setUp(): Promise<{ editor: EditorService; layout: LayoutService }> {
  const root = new RootContext();
  let editor!: EditorService;
  let layout!: LayoutService;
  await root.plugin({
    name: "editor-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, new PathHost(), layout);
    },
  });
  return { editor, layout };
}

describe("asking the language server through the focused editor", () => {
  test("each action reaches the view of the focused pane and no other", async () => {
    const { editor, layout } = await setUp();
    const focused: string[] = [];
    const others: string[] = [];
    editor.registerView(layout.focusedLeafId, recordingView(focused));
    editor.registerView("somewhere-else", recordingView(others));
    await editor.actOnFocusedView("hover");
    await editor.actOnFocusedView("definition");
    await editor.actOnFocusedView("complete");
    expect(focused).toEqual(["hover", "definition", "complete"]);
    expect(others).toEqual([]);
  });

  test("with no editor in the focused pane nothing happens and nothing throws", async () => {
    const { editor } = await setUp();
    await editor.actOnFocusedView("hover");
  });
});

describe("going to a place in another file", () => {
  test("opens the file and waits for the pane to show it before moving the cursor", async () => {
    const { editor } = await setUp();
    await editor.reveal("/src/util.ts", 3, 9);
    const request = editor.pendingReveal();
    expect(request).toEqual({ documentId: 1, line: 3, character: 9 });
    expect(editor.active()?.path).toBe("/src/util.ts");
    editor.finishReveal(request!);
    expect(editor.pendingReveal()).toBeNull();
  });

  test("a file that cannot be opened leaves no request behind", async () => {
    const { editor } = await setUp();
    const failing = new PathHost();
    failing.open = () => Promise.reject(new Error("no such file"));
    const root = new RootContext();
    let other!: EditorService;
    await root.plugin({
      name: "failing",
      apply: (ctx: Context) => {
        other = new EditorService(ctx, failing, new LayoutService(ctx, "editor", null));
      },
    });
    await other.reveal("/src/missing.ts", 0, 0);
    expect(other.pendingReveal()).toBeNull();
    expect(editor.pendingReveal()).toBeNull();
  });

  test("finishing a request that was replaced does not clear the newer one", async () => {
    const { editor } = await setUp();
    await editor.reveal("/src/a.ts", 1, 1);
    const first = editor.pendingReveal()!;
    await editor.reveal("/src/b.ts", 2, 2);
    editor.finishReveal(first);
    expect(editor.pendingReveal()).toEqual({ documentId: 2, line: 2, character: 2 });
  });
});
