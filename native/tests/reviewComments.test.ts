import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands/service";
import type { KeyEventInput } from "../kernel/keymap/keyDispatch";
import { KeymapService } from "../kernel/keymap/service";
import { DiffService } from "../plugins/diff/service";
import { EditorService, type BlockDecoration, type EditorViewMethods } from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { MenusService } from "../plugins/menus/service";
import { itemsForMenu } from "../plugins/menus/menuModel";
import { registerReviewCommands } from "../plugins/review-comments/commands";
import { blockKey, ReviewCommentsService, rowOfBlockKey, type ReviewSender } from "../plugins/review-comments/service";
import { CommentStore, commentsPath, type ReviewFiles } from "../plugins/review-comments/store";
import { FakeDiffHost, FakeDocuments } from "./support/fakeDiffHost";
import { settle } from "./support/fakeSidecar";

const ROOT = "/repo";
const FILE = "/repo/src/a.rs";
const TEXT = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

/** Files held in memory, shared by the services of two runs of the app. */
class MemoryFiles implements ReviewFiles {
  files = new Map<string, string>();

  async dataDirectory(): Promise<string> {
    return "/data";
  }

  async readIfExists(path: string): Promise<string | null> {
    const text = this.files.get(path);
    if (text === undefined) {
      return null;
    }
    return text;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }
}

/** Where a review goes, recording what was sent. */
class RecordingSender implements ReviewSender {
  sent: { sessionId: string; text: string; shown: string }[] = [];
  asked: { worktreePath: string; paths: readonly string[] }[] = [];
  session: string | null = "s1";
  failWith: string | null = null;

  sessionFor(worktreePath: string, absolutePaths: readonly string[]): string | null {
    this.asked.push({ worktreePath, paths: absolutePaths });
    return this.session;
  }

  async send(sessionId: string, text: string, shown: string): Promise<void> {
    if (this.failWith !== null) {
      throw new Error(this.failWith);
    }
    this.sent.push({ sessionId, text, shown });
  }
}

interface Setup {
  documents: FakeDocuments;
  host: FakeDiffHost;
  layout: LayoutService;
  editor: EditorService;
  diff: DiffService;
  review: ReviewCommentsService;
  sender: RecordingSender;
  files: MemoryFiles;
  ctx: Context;
  leafId: string;
  documentId: number;
}

/** The review service over a real editor, layout and diff service on fake documents, with the file's diff shown over it. */
async function setUp(files: MemoryFiles = new MemoryFiles(), show = true): Promise<Setup> {
  const root = new RootContext();
  const documents = new FakeDocuments();
  documents.files.set(FILE, TEXT);
  const host = new FakeDiffHost();
  host.head.set(FILE, "alpha\nold\ndelta\nepsilon\n");
  host.index.set(FILE, "alpha\nold\ndelta\nepsilon\n");
  host.found = [{ oldStart: 1, oldLen: 1, newStart: 1, newLen: 2 }];
  host.isOpen = (id) => documents.summaries.has(id);
  const setup = { documents, host, files, sender: new RecordingSender() } as Setup;
  await root.plugin({
    name: "review-test",
    apply(ctx: Context) {
      setup.ctx = ctx;
      setup.layout = new LayoutService(ctx, "editor", null);
      setup.editor = new EditorService(ctx, documents, setup.layout);
      setup.diff = new DiffService(ctx, setup.editor, setup.layout, host, { onFilesChanged: () => () => {} });
      setup.review = new ReviewCommentsService(
        ctx,
        setup.editor,
        setup.diff,
        setup.layout,
        { paths: () => [ROOT] },
        setup.sender,
        new CommentStore(files),
        () => 1000,
      );
    },
  });
  await setup.review.ready();
  if (show) {
    await setup.diff.showInEditor(FILE);
    setup.leafId = setup.layout.focusedLeafId;
    setup.documentId = setup.editor.active()?.id as number;
  }
  return setup;
}

/** The blocks the review put on the pane's document. */
function blocksOf(setup: Setup): BlockDecoration[] {
  const decorations = setup.documents.decorations.get(`${setup.documentId}/view:${setup.leafId}~diff:review`);
  if (decorations === undefined) {
    return [];
  }
  return decorations as BlockDecoration[];
}

/** Writes a comment on a row through the input, as a person does. */
async function comment(setup: Setup, row: number, text: string): Promise<void> {
  await setup.review.beginOnRow(setup.leafId, setup.documentId, row);
  setup.review.setDraftText(text);
  await setup.review.saveDraft();
  await settle(5);
}

/** The comments the file on disk holds, for the worktree. */
function savedComments(files: MemoryFiles): { text: string; startRow: number; endRow: number; outdated: boolean }[] {
  const raw = files.files.get(commentsPath("/data"));
  if (raw === undefined) {
    return [];
  }
  const saved = JSON.parse(raw).worktrees[ROOT];
  if (saved === undefined) {
    return [];
  }
  return saved;
}

describe("adding a comment", () => {
  test("is offered on the lines the diff changed or added, and nowhere else", async () => {
    const setup = await setUp();
    expect(setup.review.rowsFor(setup.leafId, setup.documentId)).toEqual([1, 2]);
    await setup.review.beginOnRow(setup.leafId, setup.documentId, 0);
    expect(setup.review.isDrafting()).toBe(false);
    expect(setup.diff.notice()).toContain("changed or added line");
  });

  test("opens an input under the line, which a block with a key makes room for", async () => {
    const setup = await setUp();
    await setup.review.beginOnRow(setup.leafId, setup.documentId, 2);
    expect(setup.review.isDrafting()).toBe(true);
    await settle(5);
    const [block] = blocksOf(setup);
    expect(block.key).toBe(blockKey(2));
    expect(block.start.row).toBe(2);
    expect(block.placement).toBe("below");
    expect(block.lines.length).toBeGreaterThanOrEqual(3);
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 2).map((card) => card.kind)).toEqual(["draft"]);
  });

  test("Esc, which cancels, takes the input away and keeps nothing", async () => {
    const setup = await setUp();
    await setup.review.beginOnRow(setup.leafId, setup.documentId, 2);
    setup.review.setDraftText("never mind");
    setup.review.cancelDraft();
    await settle(5);
    expect(setup.review.isDrafting()).toBe(false);
    expect(setup.review.commentsIn(ROOT)).toEqual([]);
    expect(blocksOf(setup)).toEqual([]);
  });

  test("Enter, which saves, turns the input into a card under the line, kept on disk", async () => {
    const setup = await setUp();
    await comment(setup, 2, "Rename this.");
    const [saved] = setup.review.commentsIn(ROOT);
    expect(saved).toMatchObject({ path: "src/a.rs", startRow: 2, endRow: 2, quoted: ["gamma"], text: "Rename this.", outdated: false });
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 2).map((card) => card.kind)).toEqual(["comment"]);
    expect(blocksOf(setup)).toHaveLength(1);
    expect(savedComments(setup.files)).toHaveLength(1);
  });

  test("empty text saves nothing", async () => {
    const setup = await setUp();
    await setup.review.beginOnRow(setup.leafId, setup.documentId, 1);
    setup.review.setDraftText("   ");
    await setup.review.saveDraft();
    expect(setup.review.commentsIn(ROOT)).toEqual([]);
  });

  test("a comment on a selection anchors to the last line and records the range", async () => {
    const setup = await setUp();
    setup.editor.registerView(setup.leafId, {
      async selections() {
        return [{ anchor: { row: 1, column: 2 }, head: { row: 2, column: 3 } }];
      },
      async refresh() {},
      async apply() {
        return { changed: false };
      },
    } as unknown as EditorViewMethods);
    await setup.review.beginAtSelection();
    setup.review.setDraftText("Both lines.");
    await setup.review.saveDraft();
    const [saved] = setup.review.commentsIn(ROOT);
    expect([saved.startRow, saved.endRow]).toEqual([1, 2]);
    expect(saved.quoted).toEqual(["beta", "gamma"]);
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 2)).toHaveLength(1);
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 1)).toHaveLength(0);
  });

  test("without a selection the comment goes on the cursor's line", async () => {
    const setup = await setUp();
    setup.documents.emit({ type: "selections", id: setup.documentId, row: 1, column: 0, count: 1, selected: false });
    await setup.review.beginAtSelection();
    setup.review.setDraftText("Here.");
    await setup.review.saveDraft();
    expect(setup.review.commentsIn(ROOT)[0].endRow).toBe(1);
  });

  test("comments under one line stack, each with its own card", async () => {
    const setup = await setUp();
    await comment(setup, 1, "First.");
    await comment(setup, 1, "Second.");
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 1).map((card) => card.kind)).toEqual(["comment", "comment"]);
    const [block] = blocksOf(setup);
    expect(block.lines.length).toBe(4);
  });

  test("the keys do not run while the input is open, and the input goes with its diff", async () => {
    const setup = await setUp();
    await setup.review.beginOnRow(setup.leafId, setup.documentId, 1);
    expect(setup.review.isDrafting()).toBe(true);
    await setup.diff.hideInEditor();
    await settle(5);
    expect(setup.review.isDrafting()).toBe(false);
  });
});

describe("editing and deleting", () => {
  test("edit opens the input with the comment's text, and saving replaces it in place", async () => {
    const setup = await setUp();
    await comment(setup, 1, "Old words.");
    const [original] = setup.review.commentsIn(ROOT);
    await setup.review.edit(original.id);
    expect(setup.review.draftText()).toBe("Old words.");
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 1).map((card) => card.kind)).toEqual(["draft"]);
    setup.review.setDraftText("New words.");
    await setup.review.saveDraft();
    const after = setup.review.commentsIn(ROOT);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: original.id, text: "New words." });
    expect(savedComments(setup.files)[0].text).toBe("New words.");
  });

  test("delete removes the comment, its card and the saved copy", async () => {
    const setup = await setUp();
    await comment(setup, 1, "Gone soon.");
    await setup.review.remove(setup.review.commentsIn(ROOT)[0].id);
    await settle(5);
    expect(setup.review.commentsIn(ROOT)).toEqual([]);
    expect(blocksOf(setup)).toEqual([]);
    expect(savedComments(setup.files)).toEqual([]);
  });
});

describe("comments across restarts", () => {
  test("are read from Grove's data directory by the next run, per worktree", async () => {
    const files = new MemoryFiles();
    const first = await setUp(files);
    await comment(first, 2, "Remember me.");
    const second = await setUp(files);
    expect(second.review.commentsIn(ROOT).map((saved) => saved.text)).toEqual(["Remember me."]);
    expect(second.review.commentsIn("/elsewhere")).toEqual([]);
    expect(second.review.cardsAt(second.leafId, second.documentId, 2)).toHaveLength(1);
    await settle(5);
    expect(blocksOf(second)).toHaveLength(1);
  });
});

describe("comments when the file changes", () => {
  test("a comment follows its line when lines are added above it", async () => {
    const setup = await setUp();
    await comment(setup, 2, "On gamma.");
    await setup.documents.setText(setup.documentId, `new one\nnew two\n${TEXT}`);
    await settle(400);
    const [moved] = setup.review.commentsIn(ROOT);
    expect([moved.startRow, moved.endRow, moved.outdated]).toEqual([4, 4, false]);
    expect(blocksOf(setup)[0].start.row).toBe(4);
    expect(savedComments(setup.files)[0].endRow).toBe(4);
  });

  test("a comment whose line is gone is marked outdated and kept", async () => {
    const setup = await setUp();
    await comment(setup, 2, "On gamma.");
    await setup.documents.setText(setup.documentId, "alpha\nbeta\nGAMMA CHANGED\ndelta\nepsilon\n");
    await settle(400);
    const [kept] = setup.review.commentsIn(ROOT);
    expect(kept.outdated).toBe(true);
    expect(kept.endRow).toBe(2);
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 2)).toHaveLength(1);
    expect(savedComments(setup.files)[0].outdated).toBe(true);
  });
});

describe("sending the comments to the agent", () => {
  test("sends one message to the session, with a short line for the chat, and clears the comments", async () => {
    const setup = await setUp();
    await comment(setup, 1, "First note.");
    await comment(setup, 2, "Second note.");
    expect(await setup.review.send(ROOT)).toBe(true);
    expect(setup.sender.sent).toHaveLength(1);
    const [sent] = setup.sender.sent;
    expect(sent.sessionId).toBe("s1");
    expect(sent.shown).toBe("Review: 2 comments on 1 file");
    expect(sent.text).toContain("src/a.rs:2");
    expect(sent.text).toContain("beta");
    expect(sent.text).toContain("Second note.");
    expect(setup.sender.asked[0]).toEqual({ worktreePath: ROOT, paths: [`${ROOT}/src/a.rs`, `${ROOT}/src/a.rs`] });
    expect(setup.review.commentsIn(ROOT)).toEqual([]);
    expect(savedComments(setup.files)).toEqual([]);
    await settle(5);
    expect(blocksOf(setup)).toEqual([]);
  });

  test("offers to take it back, which puts the comments where they were", async () => {
    const setup = await setUp();
    await comment(setup, 2, "Note.");
    await setup.review.send(ROOT);
    expect(setup.review.lastSent()).toEqual({ worktreePath: ROOT, count: 1 });
    await setup.review.undoSend();
    expect(setup.review.commentsIn(ROOT).map((saved) => saved.text)).toEqual(["Note."]);
    expect(setup.review.lastSent()).toBeNull();
    expect(savedComments(setup.files)).toHaveLength(1);
  });

  test("keeps the comments and says why when there is no session", async () => {
    const setup = await setUp();
    await comment(setup, 2, "Note.");
    setup.sender.session = null;
    expect(await setup.review.send(ROOT)).toBe(false);
    expect(setup.review.commentsIn(ROOT)).toHaveLength(1);
    expect(setup.diff.notice()).toContain("no agent session");
  });

  test("keeps the comments and says why when the daemon refuses", async () => {
    const setup = await setUp();
    await comment(setup, 2, "Note.");
    setup.sender.failWith = "daemon is away";
    expect(await setup.review.send(ROOT)).toBe(false);
    expect(setup.review.commentsIn(ROOT)).toHaveLength(1);
    expect(setup.diff.notice()).toContain("daemon is away");
  });

  test("sends nothing when there is nothing to send", async () => {
    const setup = await setUp();
    expect(await setup.review.send(ROOT)).toBe(false);
    expect(setup.sender.sent).toEqual([]);
  });
});

interface Keyed extends KeyEventInput {
  prevented: boolean;
}

/** A window key event as svelte-gpui delivers it. */
function press(key: string, modifiers: { ctrl?: boolean; alt?: boolean } = {}): Keyed {
  const event: Keyed = {
    key,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: false,
    metaKey: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

describe("the keys and the menu entry", () => {
  /** The review commands registered on a root with the kernel's keymap and menus, beside a service that opens drafts. */
  async function withKeys(): Promise<{ root: RootContext; setup: Setup }> {
    const root = new RootContext();
    await root.plugin(CommandsService);
    await root.plugin(KeymapService);
    await root.plugin({ name: "menus", apply: (ctx: Context) => void new MenusService(ctx) });
    const setup = await setUp();
    await root.plugin({ name: "review-commands", inject: ["commands", "keymap", "menus"], apply: (ctx: Context) => registerReviewCommands(ctx, setup.review) });
    return { root, setup };
  }

  test("the binding is in the keymap, so which-key lists it", async () => {
    const { root } = await withKeys();
    const bindings = root.keymap.effective();
    const chord = bindings.find((binding) => binding.id === "review.addComment");
    expect(chord).toMatchObject({ keys: "ctrl+alt+c", command: "review.addComment", description: "Comment on this line" });
    const leader = bindings.find((binding) => binding.id === "review.addComment.leader");
    expect(leader?.sequence.leader).toBe(true);
    expect(leader?.group).toBe("Git");
    root.keymap.allowBareKeys(() => true);
    root.keymap.dispatch(press(" "));
    root.keymap.dispatch(press("g"));
    expect(root.keymap.nextKeys()).toEqual([{ key: "c", description: "Comment on this line", continues: false }]);
  });

  test("the send key shows once there is something to send", async () => {
    const { root, setup } = await withKeys();
    await comment(setup, 2, "Note.");
    root.keymap.allowBareKeys(() => true);
    root.keymap.dispatch(press(" "));
    root.keymap.dispatch(press("g"));
    expect(root.keymap.nextKeys().map((key) => key.key).sort()).toEqual(["c", "s"]);
    root.keymap.dispatch(press("s"));
    await settle(5);
    expect(setup.sender.sent).toHaveLength(1);
  });

  test("the key opens an input under the cursor's changed line", async () => {
    const { root, setup } = await withKeys();
    setup.documents.emit({ type: "selections", id: setup.documentId, row: 2, column: 0, count: 1, selected: false });
    expect(root.keymap.dispatch(press("c", { ctrl: true, alt: true }))).toBe(true);
    await settle(5);
    expect(setup.review.isDrafting()).toBe(true);
    expect(setup.review.cardsAt(setup.leafId, setup.documentId, 2).map((card) => card.kind)).toEqual(["draft"]);
  });

  test("the key does nothing where no diff is shown", async () => {
    const { root, setup } = await withKeys();
    await setup.diff.hideInEditor();
    expect(root.keymap.dispatch(press("c", { ctrl: true, alt: true }))).toBe(false);
    expect(setup.review.isDrafting()).toBe(false);
  });

  test("the editor's context menu offers it where a diff is shown, and runs the same command", async () => {
    const { root, setup } = await withKeys();
    const items = itemsForMenu(root.menus.items(), "editor.context");
    expect(items.map((item) => item.label)).toEqual(["Comment on This Line"]);
    expect(items[0].commandId).toBe("review.addComment");
    await setup.diff.hideInEditor();
    expect(itemsForMenu(root.menus.items(), "editor.context")).toEqual([]);
  });
});

describe("block keys", () => {
  test("name the row a block is under, and only ours", () => {
    expect(rowOfBlockKey(blockKey(12))).toBe(12);
    expect(rowOfBlockKey("other")).toBeNull();
    expect(rowOfBlockKey("row:x")).toBeNull();
  });
});
