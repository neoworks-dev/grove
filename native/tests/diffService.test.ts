import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { DiffService } from "../plugins/diff/service";
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
  const setup = { documents, host } as Setup;
  await root.plugin({
    name: "diff-test",
    apply(ctx: Context) {
      setup.layout = new LayoutService(ctx, "editor", null);
      setup.editor = new EditorService(ctx, documents, setup.layout);
      setup.diff = new DiffService(ctx, setup.editor, setup.layout, host);
    },
  });
  return setup;
}

/** Moves the cursor of a document to a row, as the host reports it. */
function putCursor(setup: Setup, documentId: number, row: number): void {
  setup.documents.emit({ type: "selections", id: documentId, row, column: 0, count: 1, selected: false });
}

/** The pane that has the focus and the document of the tab it shows. */
function focused(setup: Setup): { leafId: string; documentId: number } {
  const leafId = setup.layout.focusedLeafId;
  return { leafId, documentId: setup.editor.activeTabIn(leafId)?.id as number };
}

describe("the staged changes", () => {
  test("are a diff tab of the index's text against HEAD, which is not the file's own document", async () => {
    const setup = await setUp();
    expect(await setup.diff.showInEditor(FILE, "staged")).toBe(true);
    const { leafId, documentId } = focused(setup);
    expect(setup.editor.activeTabIn(leafId)).toMatchObject({ kind: "diff", path: "", title: "a.rs" });
    expect(await setup.editor.textOf(documentId)).toBe("mid\n");
    expect(setup.host.calls).toEqual([`apply inline new=${documentId} old=- "old\n"`]);
    expect(setup.diff.inlineView(leafId, documentId)).toMatchObject({ path: FILE, baseLabel: "HEAD", staged: true, gitBase: null });
    expect(setup.diff.hasFocusedStagedDiff()).toBe(true);
  });

  test("showing them again reuses the tab and its document", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "staged");
    await setup.diff.showInEditor(FILE, "staged");
    expect(setup.editor.tabsIn(setup.layout.focusedLeafId)).toHaveLength(1);
    expect(setup.documents.summaries.size).toBe(1);
  });

  test("unstaging takes the hunk at the cursor out of the index by the file's path, and the index is read again", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "staged");
    const { documentId } = focused(setup);
    putCursor(setup, documentId, 3);
    let heard = 0;
    setup.diff.onIndexChanged(() => (heard += 1));
    setup.host.index.set(FILE, "less\n");
    await setup.diff.unstageHunk();
    expect(setup.host.calls).toContain(`unstage ${FILE} row=3`);
    expect(heard).toBe(1);
    expect(setup.diff.notice()).toBe("Unstaged the hunk.");
    expect(await setup.editor.textOf(documentId)).toBe("less\n");
  });

  test("cannot be staged or reverted", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "staged");
    await setup.diff.stageHunk();
    expect(setup.diff.notice()).toBe("These changes are staged already.");
    await setup.diff.revertHunk();
    expect(setup.host.calls.some((call) => call.startsWith("stage") || call.startsWith("revert"))).toBe(false);
  });

  test("unstaging anywhere else says where it works", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "index");
    expect(setup.diff.hasFocusedStagedDiff()).toBe(false);
    await setup.diff.unstageHunk();
    expect(setup.diff.notice()).toBe("Unstage works in a diff of the staged changes.");
  });
});

describe("a file that is gone", () => {
  test("is a diff tab of nothing against its base, which cannot be staged", async () => {
    const setup = await setUp();
    setup.host.head.set("/repo/gone.rs", "was here\n");
    expect(await setup.diff.showInEditor("/repo/gone.rs")).toBe(true);
    const { leafId, documentId } = focused(setup);
    expect(await setup.editor.textOf(documentId)).toBe("");
    expect(setup.host.calls).toEqual([`apply inline new=${documentId} old=- "was here\n"`]);
    expect(setup.diff.inlineView(leafId, documentId)).toMatchObject({ path: "/repo/gone.rs", gitBase: null, staged: false });
  });

  test("shows nothing when its base does not have it either", async () => {
    const setup = await setUp();
    expect(await setup.diff.showInEditor("/repo/nowhere.rs")).toBe(false);
    expect(setup.editor.tabsIn(setup.layout.focusedLeafId)).toEqual([]);
  });
});

describe("two texts", () => {
  test("shown again reuse their tab, and different texts get one of their own", async () => {
    const setup = await setUp();
    await setup.diff.openTexts("src/b.rs", "one\n", "two\n", "Base");
    await setup.diff.openTexts("src/b.rs", "one\n", "two\n", "Base");
    expect(setup.editor.tabsIn(setup.layout.focusedLeafId)).toHaveLength(1);
    expect(setup.editor.activeTabIn(setup.layout.focusedLeafId)?.title).toBe("b.rs");
    await setup.diff.openTexts("src/b.rs", "one\n", "three\n", "Base");
    expect(setup.editor.tabsIn(setup.layout.focusedLeafId)).toHaveLength(2);
  });

  test("cannot be staged or reverted", async () => {
    const setup = await setUp();
    await setup.diff.openTexts("b.rs", "a\n", "b\n");
    await setup.diff.stageHunk();
    await setup.diff.revertHunk();
    expect(setup.host.calls.some((call) => call.startsWith("stage") || call.startsWith("revert"))).toBe(false);
    expect(setup.diff.notice()).toContain("Only a diff of a file");
  });
});

describe("hunk actions", () => {
  test("staging in a diff tab puts the hunk under the file's cursor in the index and reads the diff again", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "index");
    const { documentId } = focused(setup);
    putCursor(setup, documentId, 4);
    let heard = 0;
    setup.diff.onIndexChanged(() => (heard += 1));
    const before = setup.host.calls.length;
    await setup.diff.stageHunk();
    expect(setup.host.calls[before]).toBe(`stage ${documentId} row=4`);
    expect(setup.host.calls.length).toBe(before + 2);
    expect(heard).toBe(1);
    expect(setup.diff.notice()).toBe("Staged the hunk.");
  });

  test("a hunk git refuses is reported and nothing is read again", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE, "index");
    setup.host.failWith = "there is no changed hunk here";
    const before = setup.host.calls.length;
    await setup.diff.stageHunk();
    expect(setup.diff.notice()).toBe("there is no changed hunk here");
    expect(setup.host.calls.length).toBe(before + 1);
  });

  test("in the file's own tab they act on its document at the cursor, against HEAD", async () => {
    const setup = await setUp();
    await setup.editor.openPath(FILE);
    const id = setup.editor.active()?.id as number;
    putCursor(setup, id, 7);
    await setup.diff.stageHunk();
    expect(setup.host.calls).toContain(`stage ${id} row=7`);
    await setup.diff.revertHunk();
    expect(setup.host.calls).toContain(`revert ${id} head row=7`);
  });

  test("previewing shows the old lines above the hunk and a second press hides them", async () => {
    const setup = await setUp();
    await setup.editor.openPath(FILE);
    const id = setup.editor.active()?.id as number;
    await setup.diff.previewHunk();
    expect(setup.host.calls).toContain(`preview ${id} row=0 git.preview`);
    await setup.diff.previewHunk();
    expect(setup.documents.decorations.get(`${id}/git.preview`)).toEqual([]);
  });
});

describe("vim's change keys", () => {
  test("]c asked of a diff tab's editor goes to the next of the diff's changes", async () => {
    const setup = await setUp();
    setup.host.found = [{ oldStart: 4, oldLen: 1, newStart: 4, newLen: 1 }];
    await setup.diff.openTexts("b.rs", "a\n", "b\n");
    const { leafId, documentId } = focused(setup);
    const commands: { type: string }[] = [];
    setup.editor.registerView(leafId, {
      async apply(command: { type: string }) {
        commands.push(command);
        return { changed: true };
      },
      async refresh() {},
    } as never);
    setup.documents.emit({ type: "change-request", id: documentId, forward: true });
    await settle(5);
    expect(commands[0]).toEqual({ type: "place_cursor", at: { row: 4, column: 0 } });
  });
});
