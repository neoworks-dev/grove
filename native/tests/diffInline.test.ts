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

describe("a diff drawn over the file in an editor pane", () => {
  test("opens the file in the editor pane and draws the difference on it, with no diff pane", async () => {
    const setup = await setUp();
    expect(await setup.diff.showInEditor(FILE)).toBe(true);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.layout.leafIds().filter((id) => setup.layout.paneTypeOf(id) === DIFF_PANE_TYPE)).toEqual([]);
    expect(setup.host.calls).toEqual([`apply inline new=${documentId} old=- "old\n"`]);
    expect(setup.host.sources).toEqual([`view:${leafId}:diff`]);
    expect(setup.diff.inlineView(leafId, documentId)).toEqual({ path: FILE, baseLabel: "HEAD", hunks: setup.host.found, gitBase: "head" });
  });

  test("the pane leaves out the git bars the diff replaces, and shows them again when the diff goes", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    expect(setup.editor.hiddenSourcesIn(leafId, documentId)).toEqual(["git.changes"]);
    await setup.diff.hideInEditor();
    expect(setup.editor.hiddenSourcesIn(leafId, documentId)).toEqual([]);
    expect(setup.diff.inlineView(leafId, documentId)).toBeUndefined();
    expect(setup.documents.decorations.get(`${documentId}/view:${leafId}:diff`)).toEqual([]);
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
    expect(setup.editor.hiddenSourcesIn(leafId, documentId)).toEqual([]);
  });

  test("a file that cannot be opened in an editor is shown in a diff pane instead", async () => {
    const setup = await setUp();
    setup.host.head.set("/repo/gone.rs", "was here\n");
    expect(await setup.diff.showInEditor("/repo/gone.rs")).toBe(false);
    expect(setup.layout.leafIds().filter((id) => setup.layout.paneTypeOf(id) === DIFF_PANE_TYPE)).toHaveLength(1);
  });

  test("showing it again for a file already showing it draws once more without stacking", async () => {
    const setup = await setUp();
    await setup.diff.showInEditor(FILE);
    await setup.diff.showInEditor(FILE);
    expect(setup.host.calls).toHaveLength(2);
    expect(setup.editor.hiddenSourcesIn(setup.layout.focusedLeafId, setup.editor.active()?.id as number)).toEqual(["git.changes"]);
  });

  test("the toggle shows the focused file's changes and a second use hides them", async () => {
    const setup = await setUp();
    await setup.editor.openPath(FILE);
    const leafId = setup.layout.focusedLeafId;
    const documentId = setup.editor.active()?.id as number;
    await setup.diff.toggleInEditor();
    expect(setup.diff.inlineView(leafId, documentId)).toBeDefined();
    await setup.diff.toggleInEditor();
    expect(setup.diff.inlineView(leafId, documentId)).toBeUndefined();
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
