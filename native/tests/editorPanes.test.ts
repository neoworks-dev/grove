import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";
import {
  EditorService,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
} from "../plugins/editor/service";

/** A host that keeps documents by path and never fails, enough to look at what panes do with them. */
function simpleHost(): DocumentHost {
  const documents = new Map<string, DocumentSummary>();
  return {
    async open(path) {
      const existing = documents.get(path);
      if (existing) {
        return existing;
      }
      const summary = { id: documents.size + 1, path, title: path.split("/").pop() as string, dirty: false };
      documents.set(path, summary);
      return summary;
    },
    async close() {},
    async save() {},
    onEvent(_handler: (event: DocumentEvent) => void) {
      return () => {};
    },
  };
}

/** A layout of one editor pane and the editor service over it. */
async function setUp(): Promise<{ layout: LayoutService; editor: EditorService }> {
  const root = new RootContext();
  let layout!: LayoutService;
  let editor!: EditorService;
  await root.plugin({
    name: "editor-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, simpleHost(), layout);
    },
  });
  return { layout, editor };
}

describe("splitting", () => {
  test("a split of an editor pane is an editor pane showing the same document", async () => {
    const { layout, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    await editor.openPath("/src/b.rs");
    const firstLeaf = layout.focusedLeafId;
    layout.splitFocused("row");
    const [, secondLeaf] = leaves(layout.root);
    expect(secondLeaf.paneTypeId).toBe("editor");
    expect(layout.focusedLeafId).toBe(secondLeaf.id);
    expect(editor.active()?.title).toBe("b.rs");
    expect(editor.tabsIn(secondLeaf.id).map((tab) => tab.title)).toEqual(["b.rs"]);
    expect(editor.tabsIn(firstLeaf).map((tab) => tab.title)).toEqual(["a.rs", "b.rs"]);
  });

  test("the panes switch tabs on their own", async () => {
    const { layout, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    const firstLeaf = layout.focusedLeafId;
    layout.splitFocused("row");
    const secondLeaf = layout.focusedLeafId;
    await editor.openPath("/src/b.rs");
    expect(editor.activeIn(secondLeaf)?.title).toBe("b.rs");
    expect(editor.activeIn(firstLeaf)?.title).toBe("a.rs");
    expect(editor.tabsIn(firstLeaf).map((tab) => tab.title)).toEqual(["a.rs"]);
  });

  test("closing a tab in one pane keeps the document while another pane shows it", async () => {
    const { layout, editor } = await setUp();
    const id = (await editor.openPath("/src/a.rs")) as number;
    const firstLeaf = layout.focusedLeafId;
    layout.splitFocused("row");
    expect(await editor.closeTab(layout.focusedLeafId, id)).toBe(true);
    expect(editor.tabsIn(layout.focusedLeafId)).toEqual([]);
    expect(editor.tabsIn(firstLeaf).map((tab) => tab.title)).toEqual(["a.rs"]);
    expect(editor.buffers()).toHaveLength(1);
  });

  test("a split of a pane that is not an editor is the same kind of pane", async () => {
    const root = new RootContext();
    let layout!: LayoutService;
    await root.plugin({ name: "layout", apply: (ctx: Context) => void (layout = new LayoutService(ctx, "terminal", null)) });
    layout.splitFocused("column");
    expect(leaves(layout.root).map((leaf) => leaf.paneTypeId)).toEqual(["terminal", "terminal"]);
  });
});

describe("closing a pane", () => {
  test("documents only that pane showed move to the pane that is left", async () => {
    const { layout, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    const firstLeaf = layout.focusedLeafId;
    layout.splitFocused("row");
    const secondLeaf = layout.focusedLeafId;
    await editor.openPath("/src/b.rs");
    layout.closeLeaf(secondLeaf);
    expect(layout.focusedLeafId).toBe(firstLeaf);
    expect(editor.tabsIn(firstLeaf).map((tab) => tab.title)).toEqual(["a.rs", "b.rs"]);
    expect(editor.activeIn(firstLeaf)?.title).toBe("a.rs");
    expect(editor.tabsIn(secondLeaf)).toEqual([]);
  });

  test("closing back to one pane keeps what that pane showed", async () => {
    const { layout, editor } = await setUp();
    await editor.openPath("/src/a.rs");
    const firstLeaf = layout.focusedLeafId;
    layout.splitFocused("row");
    layout.closeFocused();
    expect(editor.activeIn(firstLeaf)?.title).toBe("a.rs");
    expect(editor.buffers()).toHaveLength(1);
  });
});

describe("the layout's pane hooks", () => {
  test("report splits and closes with the panes involved", async () => {
    const root = new RootContext();
    let layout!: LayoutService;
    await root.plugin({ name: "layout", apply: (ctx: Context) => void (layout = new LayoutService(ctx, "editor", null)) });
    const seen: string[] = [];
    layout.onPaneSplit((created, source) => seen.push(`split ${source} -> ${created}`));
    layout.onPaneClosed((closed) => seen.push(`closed ${closed}`));
    const first = layout.focusedLeafId;
    layout.splitFocused("row");
    const second = layout.focusedLeafId;
    layout.closeLeaf(second);
    expect(seen).toEqual([`split ${first} -> ${second}`, `closed ${second}`]);
  });
});
