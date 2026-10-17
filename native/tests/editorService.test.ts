import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";
import {
  EditorService,
  indentFromSetting,
  indentLabel,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
  type EditorOptions,
} from "../plugins/editor/service";

/** The host's documents, held in memory: one document per path, with the events a real host emits. */
class FakeDocumentHost implements DocumentHost {
  documents = new Map<number, DocumentSummary>();
  closedIds: number[] = [];
  savedIds: number[] = [];
  failingPaths = new Set<string>();
  private handlers: ((event: DocumentEvent) => void)[] = [];
  private nextId = 1;

  async open(path: string): Promise<DocumentSummary> {
    if (this.failingPaths.has(path)) {
      throw new Error(`could not open ${path}`);
    }
    for (const summary of this.documents.values()) {
      if (summary.path === path) {
        return summary;
      }
    }
    const title = path.split("/").pop() as string;
    const summary = { id: this.nextId, path, title, dirty: false };
    this.nextId += 1;
    this.documents.set(summary.id, summary);
    this.emit({ type: "opened", summary });
    return summary;
  }

  async close(id: number): Promise<void> {
    this.documents.delete(id);
    this.closedIds.push(id);
    this.emit({ type: "closed", id });
  }

  async save(id: number): Promise<void> {
    this.savedIds.push(id);
    this.edit(id, false);
    this.emit({ type: "saved", id });
  }

  async setDecorations(): Promise<void> {}

  configured: EditorOptions[] = [];

  async configure(options: EditorOptions): Promise<void> {
    this.configured.push(options);
  }

  onEvent(handler: (event: DocumentEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((candidate) => candidate !== handler);
    };
  }

  /** Marks a document as changed or saved, the way typing in it would. */
  edit(id: number, dirty: boolean): void {
    const summary = this.documents.get(id) as DocumentSummary;
    this.documents.set(id, { ...summary, dirty });
    this.emit({ type: "dirty", id, dirty });
  }

  emit(event: DocumentEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

interface Setup {
  host: FakeDocumentHost;
  layout: LayoutService;
  editor: EditorService;
}

/** An editor service over a fake host and a real layout whose splits open another editor pane. */
async function setUp(): Promise<Setup> {
  const root = new RootContext();
  const host = new FakeDocumentHost();
  let layout!: LayoutService;
  let editor!: EditorService;
  await root.plugin({
    name: "editor-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, host, layout);
    },
  });
  return { host, layout, editor };
}

/** The titles of a pane's tabs. */
function titles(setup: Setup, leafId: string): string[] {
  return setup.editor.tabsIn(leafId).map((tab) => tab.title);
}

describe("opening", () => {
  test("shows the file in the focused pane as the active tab", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    const leafId = setup.layout.focusedLeafId;
    expect(titles(setup, leafId)).toEqual(["a.rs"]);
    expect(setup.editor.active()?.path).toBe("/src/a.rs");
  });

  test("open is the fire and forget form the explorer calls", async () => {
    const setup = await setUp();
    setup.editor.open("/src/a.rs");
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.editor.buffers().map((buffer) => buffer.title)).toEqual(["a.rs"]);
  });

  test("opening a second file adds a tab after the first and activates it", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    await setup.editor.openPath("/src/b.rs");
    const leafId = setup.layout.focusedLeafId;
    expect(titles(setup, leafId)).toEqual(["a.rs", "b.rs"]);
    expect(setup.editor.active()?.title).toBe("b.rs");
    expect(setup.editor.buffers().map((buffer) => buffer.title)).toEqual(["a.rs", "b.rs"]);
  });

  test("opening an open file focuses its tab instead of adding another", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    await setup.editor.openPath("/src/b.rs");
    await setup.editor.openPath("/src/a.rs");
    expect(titles(setup, setup.layout.focusedLeafId)).toEqual(["a.rs", "b.rs"]);
    expect(setup.editor.active()?.title).toBe("a.rs");
    expect(setup.editor.buffers()).toHaveLength(2);
  });

  test("a file that cannot be opened leaves the tabs alone and says why", async () => {
    const setup = await setUp();
    setup.host.failingPaths.add("/src/missing.rs");
    const id = await setup.editor.openPath("/src/missing.rs");
    expect(id).toBeNull();
    expect(setup.editor.buffers()).toEqual([]);
    expect(setup.editor.message()).toBe("could not open /src/missing.rs");
  });

  test("a file opens in an editor pane when the focus is on another kind of pane", async () => {
    const root = new RootContext();
    const host = new FakeDocumentHost();
    let layout!: LayoutService;
    let editor!: EditorService;
    await root.plugin({
      name: "editor-test",
      apply: (ctx: Context) => {
        layout = new LayoutService(ctx, "editor", "empty");
        editor = new EditorService(ctx, host, layout);
      },
    });
    layout.splitFocused("row");
    const [editorLeaf, emptyLeaf] = leaves(layout.root);
    expect(layout.focusedLeafId).toBe(emptyLeaf.id);
    await editor.openPath("/src/a.rs");
    expect(editor.tabsIn(editorLeaf.id).map((tab) => tab.title)).toEqual(["a.rs"]);
    expect(editor.tabsIn(emptyLeaf.id)).toEqual([]);
    expect(layout.focusedLeafId).toBe(editorLeaf.id);
  });
});

describe("dirty state", () => {
  test("follows the host's events and shows in buffers and tabs", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.host.edit(id, true);
    expect(setup.editor.buffers()[0].dirty).toBe(true);
    expect(setup.editor.tabsIn(setup.layout.focusedLeafId)[0].dirty).toBe(true);
    setup.host.edit(id, false);
    expect(setup.editor.active()?.dirty).toBe(false);
  });
});

describe("cycling", () => {
  test("moves through the focused pane's tabs and wraps in both directions", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    await setup.editor.openPath("/src/b.rs");
    await setup.editor.openPath("/src/c.rs");
    setup.editor.cycleTabs(1);
    expect(setup.editor.active()?.title).toBe("a.rs");
    setup.editor.cycleTabs(-1);
    expect(setup.editor.active()?.title).toBe("c.rs");
    setup.editor.cycleTabs(-1);
    expect(setup.editor.active()?.title).toBe("b.rs");
  });

  test("does nothing with a single tab", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    setup.editor.cycleTabs(1);
    expect(setup.editor.active()?.title).toBe("a.rs");
  });
});

describe("closing", () => {
  test("a clean tab closes at once and the tab beside it takes over", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    const middle = (await setup.editor.openPath("/src/b.rs")) as number;
    await setup.editor.openPath("/src/c.rs");
    setup.editor.select(setup.layout.focusedLeafId, middle);
    expect(await setup.editor.closeActiveTab()).toBe(true);
    expect(titles(setup, setup.layout.focusedLeafId)).toEqual(["a.rs", "c.rs"]);
    expect(setup.editor.active()?.title).toBe("c.rs");
    expect(setup.editor.buffers().map((buffer) => buffer.title)).toEqual(["a.rs", "c.rs"]);
    expect(setup.host.closedIds).toEqual([middle]);
  });

  test("closing the last tab leaves the pane without a document", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    await setup.editor.closeActiveTab();
    expect(setup.editor.active()).toBeNull();
    expect(setup.editor.hasActiveTab()).toBe(false);
  });

  test("a dirty tab asks first, and cancelling keeps it open", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.host.edit(id, true);
    const closing = setup.editor.closeActiveTab();
    expect(setup.editor.prompt()).toEqual({ kind: "confirm-close", documentId: id, title: "a.rs" });
    setup.editor.answerConfirmClose("cancel");
    expect(await closing).toBe(false);
    expect(setup.editor.prompt()).toBeNull();
    expect(setup.editor.buffers()).toHaveLength(1);
    expect(setup.host.closedIds).toEqual([]);
  });

  test("choosing not to save closes it and drops the changes", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.host.edit(id, true);
    const closing = setup.editor.closeActiveTab();
    setup.editor.answerConfirmClose("discard");
    expect(await closing).toBe(true);
    expect(setup.host.savedIds).toEqual([]);
    expect(setup.host.closedIds).toEqual([id]);
    expect(setup.editor.buffers()).toEqual([]);
  });

  test("choosing to save writes the file and then closes it", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.host.edit(id, true);
    const closing = setup.editor.closeActiveTab();
    setup.editor.answerConfirmClose("save");
    expect(await closing).toBe(true);
    expect(setup.host.savedIds).toEqual([id]);
    expect(setup.host.closedIds).toEqual([id]);
  });

  test("closing a document closes its tab in every pane", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.layout.splitFocused("row");
    await setup.editor.close(id);
    for (const leaf of leaves(setup.layout.root)) {
      expect(setup.editor.tabsIn(leaf.id)).toEqual([]);
    }
  });
});

describe("saving", () => {
  test("writes the active document and clears its dirty state", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    setup.host.edit(id, true);
    expect(await setup.editor.save()).toBe(true);
    expect(setup.host.savedIds).toEqual([id]);
    expect(setup.editor.active()?.dirty).toBe(false);
  });

  test("with nothing open it does nothing", async () => {
    const setup = await setUp();
    expect(await setup.editor.save()).toBe(false);
  });
});

describe("the open file prompt", () => {
  test("submitting a path closes the prompt and opens the file", async () => {
    const setup = await setUp();
    setup.editor.requestOpenFile();
    expect(setup.editor.prompt()).toEqual({ kind: "open-file" });
    setup.editor.submitOpenFile("  /src/a.rs ");
    expect(setup.editor.prompt()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.editor.buffers().map((buffer) => buffer.path)).toEqual(["/src/a.rs"]);
  });

  test("an empty path only closes it", async () => {
    const setup = await setUp();
    setup.editor.requestOpenFile();
    setup.editor.submitOpenFile("   ");
    expect(setup.editor.prompt()).toBeNull();
    expect(setup.editor.buffers()).toEqual([]);
  });
});

describe("cursor", () => {
  test("is recorded per document from the host's selection events", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    expect(setup.editor.cursorOf(id)).toBeNull();
    setup.host.emit({ type: "selections", id, row: 3, column: 7, count: 2, selected: false });
    expect(setup.editor.cursorOf(id)).toEqual({ row: 3, column: 7, count: 2, selected: false });
  });
});

describe("vim keys", () => {
  test("start as the standard keys and follow the setting", async () => {
    const setup = await setUp();
    expect(setup.editor.keymap()).toBe("standard");
    setup.editor.setKeymap("vim");
    expect(setup.editor.keymap()).toBe("vim");
    setup.editor.setKeymap("nonsense");
    expect(setup.editor.keymap()).toBe("standard");
  });

  test("the mode and pending keys come from the editor, and go when the keys are standard again", async () => {
    const setup = await setUp();
    setup.editor.setKeymap("vim");
    setup.host.emit({ type: "mode", mode: "NORMAL", pending: "2d", commandLine: null });
    expect(setup.editor.vimStatus()).toEqual({ mode: "NORMAL", pending: "2d", commandLine: null });
    setup.editor.setKeymap("standard");
    expect(setup.editor.vimStatus().mode).toBe("");
  });

  test(":q closes the tab and :q! closes it without asking about unsaved changes", async () => {
    const setup = await setUp();
    const first = (await setup.editor.openPath("/src/a.rs")) as number;
    const second = (await setup.editor.openPath("/src/b.rs")) as number;
    setup.host.emit({ type: "close-request", id: first, discard: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.host.closedIds).toEqual([first]);
    setup.host.edit(second, true);
    setup.host.emit({ type: "close-request", id: second, discard: false });
    await Promise.resolve();
    expect(setup.editor.prompt()).toEqual({ kind: "confirm-close", documentId: second, title: "b.rs" });
    setup.editor.answerConfirmClose("cancel");
    setup.host.emit({ type: "close-request", id: second, discard: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.host.closedIds).toEqual([first, second]);
  });

  test(":e opens the file it names", async () => {
    const setup = await setUp();
    setup.host.emit({ type: "open-request", id: 1, path: "/src/c.rs" });
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.editor.buffers().map((buffer) => buffer.title)).toEqual(["c.rs"]);
  });
});

describe("indentation", () => {
  test("the status bar's label comes from what the host says about the file", async () => {
    const setup = await setUp();
    const id = (await setup.editor.openPath("/src/a.rs")) as number;
    expect(setup.editor.active()?.indent).toBeNull();
    setup.host.emit({ type: "indent", id, indent: { kind: "spaces", width: 2 } });
    const indent = setup.editor.active()?.indent;
    expect(indent).toEqual({ kind: "spaces", width: 2 });
    expect(indentLabel(indent as NonNullable<typeof indent>)).toBe("Spaces: 2");
    setup.host.emit({ type: "indent", id, indent: { kind: "tabs" } });
    expect(indentLabel(setup.editor.active()?.indent as NonNullable<typeof indent>)).toBe("Tabs");
  });

  test("a document that opens with its indentation keeps it", async () => {
    const setup = await setUp();
    setup.host.emit({
      type: "opened",
      summary: { id: 9, path: "/src/go.go", title: "go.go", dirty: false, indent: { kind: "tabs" } },
    });
    expect(setup.editor.buffers()[0].indent).toEqual({ kind: "tabs" });
  });

  test("changing it sends the focused editor a set_indent command", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    const sent: unknown[] = [];
    setup.editor.registerView(setup.layout.focusedLeafId, {
      apply: async (command) => {
        sent.push(command);
        return { changed: true };
      },
      refresh: async () => {},
    });
    await setup.editor.setIndent({ kind: "spaces", width: 8 });
    expect(sent).toEqual([{ type: "set_indent", style: { kind: "spaces", width: 8 } }]);
  });

  test("the settings reach the host, and the views draw again", async () => {
    const setup = await setUp();
    await setup.editor.openPath("/src/a.rs");
    let refreshes = 0;
    setup.editor.registerView(setup.layout.focusedLeafId, {
      apply: async () => ({ changed: false }),
      refresh: async () => {
        refreshes += 1;
      },
    });
    const options = {
      defaultIndent: indentFromSetting("spaces-2"),
      smoothScroll: false,
      indentGuides: true,
      occurrenceHighlights: true,
    };
    await setup.editor.configure(options);
    expect(setup.host.configured).toEqual([options]);
    expect(refreshes).toBe(1);
  });

  test("the default indentation setting names tabs or a width, and falls back to four spaces", () => {
    expect(indentFromSetting("tabs")).toEqual({ kind: "tabs" });
    expect(indentFromSetting("spaces-8")).toEqual({ kind: "spaces", width: 8 });
    expect(indentFromSetting("spaces-x")).toEqual({ kind: "spaces", width: 4 });
    expect(indentFromSetting("nonsense")).toEqual({ kind: "spaces", width: 4 });
  });
});
