import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { DIFF_PANE_TYPE, DiffService } from "../plugins/diff/service";
import { EditorService } from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { FakeDiffHost, FakeDocuments } from "./support/fakeDiffHost";
import { settle } from "./support/fakeSidecar";

const FILE = "/repo/a.rs";

interface Setup {
  documents: FakeDocuments;
  host: FakeDiffHost;
  layout: LayoutService;
  editor: EditorService;
  diff: DiffService;
  filesChanged: () => void;
}

/** A diff service over fake documents and a fake git, with a real layout whose first pane is an editor. */
async function setUp(): Promise<Setup> {
  const root = new RootContext();
  const documents = new FakeDocuments();
  documents.files.set(FILE, "new\n");
  const host = new FakeDiffHost();
  host.head.set(FILE, "old\n");
  host.index.set(FILE, "mid\n");
  host.found = [{ oldStart: 0, oldLen: 1, newStart: 0, newLen: 1 }];
  host.isOpen = (id) => documents.summaries.has(id);
  let handler: () => void = () => {};
  const setup = { documents, host } as Setup;
  await root.plugin({
    name: "diff-inline-test",
    apply(ctx: Context) {
      setup.layout = new LayoutService(ctx, "editor", null);
      setup.editor = new EditorService(ctx, documents, setup.layout);
      setup.diff = new DiffService(ctx, setup.editor, setup.layout, host, {
        onFilesChanged: (listener) => {
          handler = listener;
          return () => {};
        },
      });
    },
  });
  setup.filesChanged = () => handler();
  return setup;
}

/** Waits for the delay edits are gathered over, and a little more. */
function afterReapplyDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

describe("a diff tab in an editor pane", () => {
  test("opens a diff tab of the file in the editor pane and draws the difference on it, with no diff pane", async () => {
    const setup = await setUp();
    expect(await setup.diff.showInEditor(FILE)).toBe(true);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.layout.leafIds().filter((id) => setup.layout.paneTypeOf(id) === DIFF_PANE_TYPE)).toEqual([]);
    expect(setup.editor.tabsIn(leafId).map((tab) => tab.key)).toEqual([`${documentId}:diff`]);
    expect(setup.host.calls).toEqual([`apply inline new=${documentId} old=- "old\n"`]);
    expect(setup.host.sources).toEqual([`view:${leafId}~diff:diff`]);
    expect(setup.diff.inlineView(leafId, documentId)).toEqual({ path: FILE, baseLabel: "HEAD", hunks: setup.host.found, gitBase: "head", mode: "inline" });
  });

  test("the file's own tab beside it shows no diff and keeps the git bars", async () => {
    const setup = await setUp();
    const documentId = (await setup.editor.openPath(FILE)) as number;
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    expect(setup.editor.tabsIn(leafId).map((tab) => tab.kind)).toEqual(["file", "diff"]);
    setup.editor.select(leafId, documentId);
    expect(setup.diff.inlineView(leafId, documentId)).toBeUndefined();
    expect(setup.editor.hiddenSourcesIn(leafId, documentId)).toEqual([]);
    setup.editor.select(leafId, documentId, "diff");
    expect(setup.diff.inlineView(leafId, documentId)).toBeDefined();
  });

  test("the diff tab leaves out the git bars the diff replaces, and closing its only tab closes the document", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.editor.hiddenSourcesIn(leafId, documentId, "diff")).toEqual(["git.changes"]);
    await setup.diff.hideInEditor();
    await settle(5);
    expect(setup.editor.hiddenSourcesIn(leafId, documentId, "diff")).toEqual([]);
    expect(setup.diff.inlineViews()).toEqual([]);
    expect(setup.documents.summaries.has(documentId)).toBe(false);
  });

  test("closing the diff tab keeps the file's own tab open", async () => {
    const setup = await setUp();
    const documentId = (await setup.editor.openPath(FILE)) as number;
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    await setup.editor.closeTab(leafId, documentId, "diff");
    await settle(5);
    expect(setup.editor.tabsIn(leafId).map((tab) => tab.key)).toEqual([String(documentId)]);
    expect(setup.diff.inlineViews()).toEqual([]);
    expect(setup.documents.summaries.has(documentId)).toBe(true);
  });

  test("two texts are a diff tab of a document that belongs to no file", async () => {
    const setup = await setUp();
    const tab = await setup.diff.showTextsInEditor("b.rs", "one\n", "two\n", "Before the agent");
    expect(tab).not.toBeNull();
    const shown = tab as { leafId: string; documentId: number };
    expect(setup.editor.activeTabIn(shown.leafId)).toMatchObject({ id: shown.documentId, kind: "diff", path: "" });
    expect(setup.host.calls).toEqual([`apply inline new=${shown.documentId} old=- "one\n"`]);
    expect(setup.diff.inlineView(shown.leafId, shown.documentId)).toMatchObject({ baseLabel: "Before the agent", gitBase: null });
  });

  test("an unstaged file is compared with the index, a staged one with HEAD, and a text is what the caller gave", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "index");
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.host.calls[0]).toContain('"mid\n"');
    expect(setup.diff.inlineView(leafId, documentId)?.baseLabel).toBe("Index");
    await setup.diff.showInEditor(FILE, "staged");
    expect(setup.host.calls[1]).toContain('"old\n"');
    expect(setup.diff.inlineView(leafId, documentId)?.baseLabel).toBe("HEAD");
    await setup.diff.showInEditor(FILE, { text: "first\n", label: "the agent's start" });
    expect(setup.host.calls[2]).toContain('"first\n"');
    expect(setup.diff.inlineView(leafId, documentId)).toMatchObject({ baseLabel: "the agent's start", gitBase: null });
  });

  test("edits to the file draw the difference again once they stop", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    const documentId = setup.editor.active()?.id as number;
    setup.documents.emit({ type: "edited", id: documentId });
    setup.documents.emit({ type: "edited", id: documentId });
    expect(setup.host.calls).toHaveLength(1);
    await afterReapplyDelay();
    expect(setup.host.calls).toHaveLength(2);
  });

  test("a change on disk or in the index reads the old text again", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    setup.host.head.set(FILE, "newer old\n");
    setup.filesChanged();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(setup.host.calls[1]).toContain('"newer old\n"');
    setup.host.head.set(FILE, "latest\n");
    await setup.diff.refreshAll();
    expect(setup.host.calls[2]).toContain('"latest\n"');
  });

  test("closing the file takes its diff with it", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    await setup.editor.close(documentId);
    await settle(5);
    expect(setup.diff.inlineView(leafId, documentId)).toBeUndefined();
    expect(setup.diff.inlineViews()).toEqual([]);
    expect(setup.editor.hiddenSourcesIn(leafId, documentId, "diff")).toEqual([]);
  });

  test("a file that cannot be opened shows no diff, and no diff pane either", async () => {
    const setup = await setUp();
    setup.host.head.set("/repo/gone.rs", "was here\n");
    expect(await setup.diff.showInEditor("/repo/gone.rs")).toBe(false);
    expect(setup.layout.leafIds().filter((id) => setup.layout.paneTypeOf(id) === DIFF_PANE_TYPE)).toEqual([]);
  });

  test("showing it again for a file already showing it draws once more in the same tab", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.host.calls).toHaveLength(2);
    expect(setup.editor.tabsIn(leafId)).toHaveLength(1);
    expect(setup.editor.hiddenSourcesIn(leafId, documentId, "diff")).toEqual(["git.changes"]);
  });

  test("the toggle opens the focused file's diff tab, and from there goes back to the file", async () => {
    const setup = await setUp();
    await setup.editor.openPath(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    await setup.diff.toggleInEditor();
    expect(setup.editor.activeTabIn(leafId)?.kind).toBe("diff");
    expect(setup.diff.inlineView(leafId, documentId)).toBeDefined();
    await setup.diff.toggleInEditor();
    await settle(5);
    expect(setup.editor.activeTabIn(leafId)?.kind).toBe("file");
    expect(setup.diff.inlineViews()).toEqual([]);
  });
});

describe("a diff tab side by side", () => {
  test("the old text is a document the tab draws beside the file, and going back inline closes it", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    await setup.diff.toggleMode();
    const oldId = setup.editor.companionOf(leafId, documentId, "diff") as number;
    expect(oldId).not.toBeNull();
    expect(await setup.editor.textOf(oldId)).toBe("old\n");
    expect(setup.host.calls[1]).toBe(`apply split new=${documentId} old=${oldId} "old\n"`);
    expect(setup.diff.inlineView(leafId, documentId)?.mode).toBe("split");
    expect(setup.editor.companionOf(leafId, documentId, "file")).toBeNull();

    await setup.diff.toggleMode();
    expect(setup.editor.companionOf(leafId, documentId, "diff")).toBeNull();
    expect(setup.documents.summaries.has(oldId)).toBe(false);
    expect(setup.host.calls[2]).toBe(`apply inline new=${documentId} old=- "old\n"`);
  });

  test("a diff tab opens side by side when the setting says so", async () => {
    const setup = await setUp();
    setup.diff.configure("split");
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.diff.inlineView(leafId, documentId)?.mode).toBe("split");
    expect(setup.editor.companionOf(leafId, documentId, "diff")).not.toBeNull();
  });

  test("closing the tab closes the old side's document too", async () => {
    const setup = await setUp();
    setup.diff.configure("split");
    await setup.editor.openPath(FILE);
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    const oldId = setup.editor.companionOf(leafId, documentId, "diff") as number;
    await setup.editor.closeTab(leafId, documentId, "diff");
    await settle(5);
    expect(setup.documents.summaries.has(oldId)).toBe(false);
    expect(setup.documents.summaries.has(documentId)).toBe(true);
  });
});

describe("moving through and acting on the changes of a diff over the file", () => {
  test("the next change is found among the hunks the diff drew", async () => {
    const setup = await setUp();
    setup.host.found = [
      { oldStart: 2, oldLen: 1, newStart: 2, newLen: 1 },
      { oldStart: 9, oldLen: 1, newStart: 9, newLen: 1 },
    ];
    await setup.diff.showInEditor(FILE);
    setup.host.found = [];
    const commands: { type: string; [field: string]: unknown }[] = [];
    setup.editor.registerView(setup.layout.focusedLeafId, {
      async apply(command: { type: string }) {
        commands.push(command);
        return { changed: true };
      },
      async refresh() {},
    } as never);
    await setup.diff.stepChange(1);
    expect(commands[0]).toEqual({ type: "place_cursor", at: { row: 2, column: 0 } });
  });

  test("reverting puts back the lines of the base the diff compares with", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "index");
    const documentId = setup.editor.active()?.id as number;
    await setup.diff.revertHunk();
    expect(setup.host.calls).toContain(`revert ${documentId} index row=0`);
  });

  test("a diff against a text cannot be reverted", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, { text: "first\n", label: "the agent's start" });
    await setup.diff.revertHunk();
    expect(setup.host.calls.some((call) => call.startsWith("revert"))).toBe(false);
    expect(setup.diff.notice()).toContain("HEAD or the index");
  });
});
