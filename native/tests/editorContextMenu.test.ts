import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { directoryOf, relativeToWorktree } from "../plugins/editor-context-menu/fileCommands";
import { CONTEXT_MENU_ID, SELECTION_COMMANDS, contextMenuItems } from "../plugins/editor-context-menu/items";
import { EditorService, type ContextMenuRequest, type EditorViewMethods } from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { itemsForMenu, menuRows } from "../plugins/menus/menuModel";
import { languageStubs } from "./support/viewStubs";
import { FakeDocuments } from "./support/fakeDiffHost";

/** The labels the menu would show when only these commands exist. */
function labelsWith(commandIds: string[]): string[] {
  const available = new Set(commandIds);
  const items = itemsForMenu(contextMenuItems((commandId) => available.has(commandId)), CONTEXT_MENU_ID);
  return items.map((item) => item.label);
}

describe("the entries of the editor's menu", () => {
  test("an entry whose command no plugin has registered is left out, and appears once it is", () => {
    expect(labelsWith(["edit.copy", "editor.goToDefinition"])).toEqual(["Copy", "Go to Definition"]);
    const withLanguage = labelsWith(["edit.copy", "editor.goToDefinition", "editor.rename", "editor.findReferences"]);
    expect(withLanguage).toEqual(["Copy", "Go to Definition", "Find References", "Rename Symbol"]);
  });

  test("the groups come in order with a separator between them", () => {
    const available = new Set(["edit.cut", "edit.paste", "editor.rename", "git.stageHunk", "editor.copyPath"]);
    const items = itemsForMenu(contextMenuItems((commandId) => available.has(commandId)), CONTEXT_MENU_ID);
    const rows = menuRows(items, () => {});
    expect(rows.map((row) => (row.separator ? "-" : row.label))).toEqual(["Cut", "Paste", "-", "Rename Symbol", "-", "Stage Hunk", "-", "Copy Path"]);
  });

  test("choosing an entry hands over the item, which names the command to run", () => {
    const chosen: (string | undefined)[] = [];
    const items = itemsForMenu(contextMenuItems(() => true), CONTEXT_MENU_ID);
    const rows = menuRows(items, (item) => chosen.push(item.commandId));
    rows.find((row) => row.label === "Format Document")?.onselect?.();
    expect(chosen).toEqual(["editor.formatDocument"]);
  });

  test("only cut and copy need selected text", () => {
    expect([...SELECTION_COMMANDS].sort()).toEqual(["edit.copy", "edit.cut"]);
  });
});

describe("file paths", () => {
  test("a path from the worktree's root, or whole when the file is outside it", () => {
    expect(relativeToWorktree("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relativeToWorktree("/other/a.ts", "/repo")).toBe("/other/a.ts");
    expect(relativeToWorktree("/repo/a.ts", null)).toBe("/repo/a.ts");
  });

  test("the directory of a file", () => {
    expect(directoryOf("/repo/src/a.ts")).toBe("/repo/src");
    expect(directoryOf("/a.ts")).toBe("/");
  });
});

/** A view that answers right presses as the editor does, and records them. */
function pressableView(selected: boolean, presses: string[]): EditorViewMethods {
  return {
    ...languageStubs(),
    apply: async () => ({ changed: false }),
    refresh: async () => {},
    contextClick: async (x, y) => {
      presses.push(`${x},${y}`);
      return { selected };
    },
  };
}

/** The editor service with one pane, and the requests it hears for menus. */
async function setUp() {
  const root = new RootContext();
  const documents = new FakeDocuments();
  let editor!: EditorService;
  let layout!: LayoutService;
  await root.plugin({
    name: "context-menu-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, documents, layout);
    },
  });
  const requests: ContextMenuRequest[] = [];
  editor.onContextMenu((request) => requests.push(request));
  return { editor, layout, requests };
}

describe("a right press in an editor", () => {
  test("the view places the cursor, and whoever shows menus is told where and whether text is selected", async () => {
    const { editor, layout, requests } = await setUp();
    const presses: string[] = [];
    editor.registerView(layout.focusedLeafId, pressableView(true, presses));
    await editor.openContextMenu(layout.focusedLeafId, 120, 80);
    expect(presses).toEqual(["120,80"]);
    expect(requests).toEqual([{ leafId: layout.focusedLeafId, x: 120, y: 80, hasSelection: true }]);
  });

  test("a pane without an editor opens no menu", async () => {
    const { editor, requests } = await setUp();
    await editor.openContextMenu("nowhere", 1, 1);
    expect(requests).toEqual([]);
  });

  test("a view that cannot take right presses opens no menu either", async () => {
    const { editor, layout, requests } = await setUp();
    editor.registerView(layout.focusedLeafId, { ...languageStubs(), apply: async () => ({ changed: false }), refresh: async () => {} });
    await editor.openContextMenu(layout.focusedLeafId, 1, 1);
    expect(requests).toEqual([]);
  });

  test("the menu stops hearing once the listener lets go", async () => {
    const { editor, layout } = await setUp();
    editor.registerView(layout.focusedLeafId, pressableView(false, []));
    const heard: number[] = [];
    const stop = editor.onContextMenu(() => heard.push(1));
    await editor.openContextMenu(layout.focusedLeafId, 1, 1);
    stop();
    await editor.openContextMenu(layout.focusedLeafId, 1, 1);
    expect(heard).toEqual([1]);
  });
});
