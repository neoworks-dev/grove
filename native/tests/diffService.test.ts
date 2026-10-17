import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { DiffService, DIFF_PANE_TYPE } from "../plugins/diff/service";
import { EditorService, type EditorViewMethods } from "../plugins/editor/service";
import { languageStubs } from "./support/viewStubs";
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

/** A diff service over fake documents and a fake git, with a real layout and editor service. */
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
    name: "diff-test",
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

/** An editor view that records the commands it is given. */
function recordingView(): EditorViewMethods & { commands: { type: string }[]; refreshes: number } {
  const view = {
    ...languageStubs(),
    commands: [] as { type: string }[],
    refreshes: 0,
    async apply(command: { type: string }) {
      view.commands.push(command);
      return { changed: true };
    },
    async refresh() {
      view.refreshes += 1;
    },
  };
  return view;
}

describe("opening a diff", () => {
  test("splits off a diff pane, compares the file with HEAD and draws it inline", async () => {
    const setup = await setUp();
    const leafId = await setup.diff.openFile(FILE);
    expect(leafId).not.toBeNull();
    expect(setup.layout.paneTypeOf(leafId as string)).toBe(DIFF_PANE_TYPE);
    const view = setup.diff.view(leafId as string);
    expect(view?.status).toBe("ready");
    expect(view?.baseLabel).toBe("HEAD");
    expect(view?.editable).toBe(true);
    expect(view?.hunks).toEqual(setup.host.found);
    expect(setup.host.calls).toEqual([`apply inline new=${view?.rightId} old=- "old\n"`]);
  });

  test("the file's document is not given a tab, so nothing is left behind when the pane goes", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    expect(setup.editor.buffers().map((buffer) => buffer.path)).toEqual([FILE]);
    expect(setup.editor.tabsIn(leafId)).toEqual([]);
    setup.layout.closeLeaf(leafId);
    await settle(5);
    expect(setup.documents.closed).toHaveLength(1);
    expect(setup.editor.buffers()).toEqual([]);
  });

  test("asking for the same diff again shows the pane that has it", async () => {
    const setup = await setUp();
    const first = await setup.diff.openFile(FILE);
    setup.layout.focus(setup.layout.leafIds()[0]);
    const second = await setup.diff.openFile(FILE);
    expect(second).toBe(first);
    expect(setup.layout.focusedLeafId).toBe(first as string);
    expect(setup.layout.leafIds().filter((id) => setup.layout.paneTypeOf(id) === DIFF_PANE_TYPE)).toHaveLength(1);
  });

  test("a diff against the index reads the index, and a staged one compares it with HEAD", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE, "index")) as string;
    expect(setup.host.calls[0]).toContain('"mid\n"');
    expect(setup.diff.view(leafId)?.canStage).toBe(true);
    await setup.diff.openFile(FILE, "staged");
    const view = setup.diff.view(leafId);
    expect(view?.baseLabel).toBe("Staged");
    expect(view?.editable).toBe(false);
    expect(view?.canUnstage).toBe(true);
    expect(await setup.editor.textOf(view?.rightId as number)).toBe("mid\n");
    expect(setup.host.calls[1]).toContain('"old\n"');
  });

  test("two texts can be compared without a file", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openTexts("b.rs", "one\n", "two\n", "Before the agent")) as string;
    const view = setup.diff.view(leafId);
    expect(view?.baseLabel).toBe("Before the agent");
    expect(view?.editable).toBe(false);
    expect(view?.canStage || view?.canRevert).toBe(false);
    expect(await setup.editor.textOf(view?.rightId as number)).toBe("two\n");
  });

  test("a file that is gone is shown as nothing, read-only", async () => {
    const setup = await setUp();
    setup.host.head.set("/repo/gone.rs", "was here\n");
    const leafId = (await setup.diff.openFile("/repo/gone.rs")) as string;
    const view = setup.diff.view(leafId);
    expect(view?.status).toBe("ready");
    expect(view?.editable).toBe(false);
    expect(await setup.editor.textOf(view?.rightId as number)).toBe("");
  });
});

describe("the two layouts", () => {
  test("side by side opens a document for the old text and draws both, and inline lets it go", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    await setup.diff.setMode(leafId, "split");
    const split = setup.diff.view(leafId);
    expect(split?.mode).toBe("split");
    expect(split?.leftId).not.toBeNull();
    expect(await setup.editor.textOf(split?.leftId as number)).toBe("old\n");
    expect(setup.host.calls[1]).toBe(`apply split new=${split?.rightId} old=${split?.leftId} "old\n"`);
    await setup.diff.setMode(leafId, "inline");
    const inline = setup.diff.view(leafId);
    expect(inline?.leftId).toBeNull();
    expect(setup.documents.closed).toContain(split?.leftId as number);
    expect(setup.documents.decorations.get(`${split?.leftId}/view:${leafId}:diff`)).toEqual([]);
  });

  test("toggling switches between them and the choice is what the next diff opens in", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    await setup.diff.toggleMode(leafId);
    expect(setup.diff.view(leafId)?.mode).toBe("split");
    expect(setup.diff.mode()).toBe("split");
    await setup.diff.toggleMode(leafId);
    expect(setup.diff.view(leafId)?.mode).toBe("inline");
  });
});

describe("keeping up with the files", () => {
  test("editing the new side works the difference out again once the edits stop", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    const rightId = setup.diff.view(leafId)?.rightId as number;
    const before = setup.host.calls.length;
    setup.documents.emit({ type: "edited", id: rightId });
    setup.documents.emit({ type: "edited", id: rightId });
    await settle(200);
    expect(setup.host.calls.length).toBe(before + 1);
  });

  test("a change on disk reads the index again", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE, "index")) as string;
    setup.host.index.set(FILE, "newer\n");
    setup.filesChanged();
    await settle(500);
    expect(setup.host.calls.at(-1)).toContain('"newer\n"');
    expect(setup.diff.view(leafId)?.status).toBe("ready");
  });
});

describe("moving between changes", () => {
  test("goes to the next hunk after the cursor and centres it", async () => {
    const setup = await setUp();
    setup.host.found = [
      { oldStart: 2, oldLen: 1, newStart: 2, newLen: 1 },
      { oldStart: 9, oldLen: 1, newStart: 9, newLen: 1 },
    ];
    const leafId = (await setup.diff.openFile(FILE)) as string;
    const view = recordingView();
    setup.diff.registerEditors(leafId, { right: view });
    await setup.diff.stepChange(1);
    expect(view.commands).toEqual([
      { type: "place_cursor", at: { row: 2, column: 0 } },
      { type: "scroll_to", align: "center" },
    ]);
    setup.documents.emit({ type: "selections", id: setup.diff.view(leafId)?.rightId as number, row: 2, column: 0, count: 1, selected: false });
    await setup.diff.stepChange(1);
    expect(view.commands[2]).toEqual({ type: "place_cursor", at: { row: 9, column: 0 } });
  });
});

describe("vim's change keys", () => {
  test("]c and [c asked of an editor go to the next and previous change", async () => {
    const setup = await setUp();
    setup.host.found = [{ oldStart: 4, oldLen: 1, newStart: 4, newLen: 1 }];
    const leafId = (await setup.diff.openFile(FILE)) as string;
    const view = recordingView();
    setup.diff.registerEditors(leafId, { right: view });
    setup.documents.emit({ type: "change-request", id: setup.diff.view(leafId)?.rightId as number, forward: true });
    await settle(5);
    expect(view.commands[0]).toEqual({ type: "place_cursor", at: { row: 4, column: 0 } });
  });
});

describe("hunk actions", () => {
  test("staging puts the hunk under the cursor in the index and reads the diff again", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE, "index")) as string;
    const rightId = setup.diff.view(leafId)?.rightId as number;
    setup.documents.emit({ type: "selections", id: rightId, row: 4, column: 0, count: 1, selected: false });
    let heard = 0;
    setup.diff.onIndexChanged(() => (heard += 1));
    const applies = setup.host.calls.length;
    await setup.diff.stageHunk();
    expect(setup.host.calls[applies]).toBe(`stage ${rightId} row=4`);
    expect(setup.host.calls.length).toBe(applies + 2);
    expect(heard).toBe(1);
    expect(setup.diff.notice()).toBe("Staged the hunk.");
  });

  test("a hunk git refuses is reported and nothing is read again", async () => {
    const setup = await setUp();
    await setup.diff.openFile(FILE, "index");
    setup.host.failWith = "there is no changed hunk here";
    const calls = setup.host.calls.length;
    await setup.diff.stageHunk();
    expect(setup.diff.notice()).toBe("there is no changed hunk here");
    expect(setup.host.calls.length).toBe(calls + 1);
  });

  test("unstaging works on the staged diff and by the file's path", async () => {
    const setup = await setUp();
    await setup.diff.openFile(FILE, "staged");
    await setup.diff.unstageHunk();
    expect(setup.host.calls.some((call) => call === `unstage ${FILE} row=0`)).toBe(true);
  });

  test("reverting names the base the diff compares with", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE, "head")) as string;
    const rightId = setup.diff.view(leafId)?.rightId as number;
    await setup.diff.revertHunk();
    expect(setup.host.calls).toContain(`revert ${rightId} head row=0`);
  });

  test("a diff of two texts cannot be staged or reverted", async () => {
    const setup = await setUp();
    await setup.diff.openTexts("b.rs", "a\n", "b\n");
    await setup.diff.revertHunk();
    expect(setup.host.calls.some((call) => call.startsWith("revert"))).toBe(false);
    expect(setup.diff.notice()).toContain("Only a diff of a file");
  });

  test("in a normal editor they act on the file's document at the cursor", async () => {
    const setup = await setUp();
    await setup.editor.openPath(FILE);
    const id = setup.editor.active()?.id as number;
    setup.documents.emit({ type: "selections", id, row: 7, column: 0, count: 1, selected: false });
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

/** An editor view as one that is no longer mounted answers: it throws, as `callMethod` does for a node that is gone. */
function unmountedView(): EditorViewMethods {
  return {
    async apply() {
      throw new TypeError("cannot read property 'hostId' of null");
    },
    refresh() {
      throw new TypeError("cannot read property 'hostId' of null");
    },
  };
}

/** Lets a gated drawing go on. */
function openGate(host: FakeDiffHost): () => void {
  let release: () => void = () => {};
  host.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    host.gate = null;
    release();
  };
}

describe("a pane that loads while the diff is opened", () => {
  test("the pane mounting and asking for its diff while it is opened loads it once", async () => {
    const setup = await setUp();
    const opening = setup.diff.openFile(FILE);
    // The pane exists as soon as it is split off, and its mount asks for the diff its state names.
    setup.diff.ensureLoaded(setup.layout.focusedLeafId);
    const leafId = (await opening) as string;
    await settle(5);
    expect(setup.diff.view(leafId)?.status).toBe("ready");
    expect(setup.documents.closed).toEqual([]);
    expect(setup.host.drawnOnClosed).toEqual([]);
  });
});

describe("a pane that goes while it is being drawn", () => {
  test("closing it during a drawing leaves nothing drawn on a released document and nothing rejected", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const release = openGate(setup.host);
    const switching = setup.diff.setMode(leafId, "split");
    await settle(5);
    setup.layout.closeLeaf(leafId);
    await settle(5);
    release();
    await switching;
    await settle(20);
    process.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
    expect(setup.host.drawnOnClosed).toEqual([]);
    expect(setup.documents.summaries.size).toBe(0);
  });

  test("a drawing that finds the pane's editors gone does not fail, and the old record's editors are not asked", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    setup.diff.registerEditors(leafId, { left: unmountedView(), right: unmountedView() });
    await setup.diff.setMode(leafId, "split");
    expect(setup.diff.view(leafId)?.status).toBe("ready");
    setup.layout.closeLeaf(leafId);
    await settle(5);
    await setup.diff.refreshAll();
    expect(setup.diff.view(leafId)).toBeUndefined();
  });
});

describe("switching layouts quickly", () => {
  test("going to side by side and back during a drawing leaves no extra documents", async () => {
    const setup = await setUp();
    const leafId = (await setup.diff.openFile(FILE)) as string;
    const release = openGate(setup.host);
    const toSplit = setup.diff.setMode(leafId, "split");
    await settle(5);
    const toInline = setup.diff.setMode(leafId, "inline");
    await settle(5);
    release();
    await Promise.all([toSplit, toInline]);
    await settle(10);
    const view = setup.diff.view(leafId);
    expect(view?.mode).toBe("inline");
    expect(view?.status).toBe("ready");
    expect(view?.leftId).toBeNull();
    expect([...setup.documents.summaries.keys()]).toEqual([view?.rightId as number]);
    expect(setup.host.drawnOnClosed).toEqual([]);
  });
});
