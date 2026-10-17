import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { Context as RootContext } from "@neoworks/extension-system";
import {
  BLAME_SOURCE,
  CHANGES_SOURCE,
  blameText,
  changeDecorations,
  relativeTime,
  type Blame,
  type FileChanges,
} from "../plugins/git-gutter/changes";
import type { GitHost } from "../plugins/git-gutter/gitHost";
import { GitGutterService } from "../plugins/git-gutter/service";
import {
  EditorService,
  type Decoration,
  type DocumentEvent,
  type DocumentHost,
  type DocumentSummary,
} from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import { settle } from "./support/fakeSidecar";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("what git says becomes decorations", () => {
  test("added lines get a bar over their rows, changed lines another tone, and deleted lines a notch", () => {
    const decorations = changeDecorations([
      { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 },
      { oldStart: 9, oldCount: 2, newStart: 11, newCount: 3 },
      { oldStart: 20, oldCount: 3, newStart: 21, newCount: 0 },
    ]);
    expect(decorations).toEqual([
      { kind: "gutter", start: { row: 3, column: 0 }, end: { row: 4, column: 0 }, mark: "bar", tone: "added" },
      { kind: "gutter", start: { row: 10, column: 0 }, end: { row: 12, column: 0 }, mark: "bar", tone: "modified" },
      { kind: "gutter", start: { row: 21, column: 0 }, mark: "notch", tone: "deleted" },
    ]);
  });

  test("blame says who, how long ago and why", () => {
    const blame: Blame = { hash: "abc", author: "Ada Lovelace", time: (NOW - 3 * DAY_MS) / 1000, summary: "Add the engine", committed: true };
    expect(blameText(blame, NOW)).toBe("Ada Lovelace, 3 days ago • Add the engine");
    expect(blameText({ ...blame, committed: false }, NOW)).toBe("Not committed yet");
  });

  test("times are told in the largest unit that fits", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - 5 * 3600_000, NOW)).toBe("5 hours ago");
    expect(relativeTime(NOW - 45 * DAY_MS, NOW)).toBe("1 month ago");
    expect(relativeTime(NOW - 800 * DAY_MS, NOW)).toBe("2 years ago");
    expect(relativeTime(NOW + 1000, NOW)).toBe("just now");
  });
});

/** Documents that keep the decorations they are given, and report them as events say. */
class RecordingHost implements DocumentHost {
  documents = new Map<string, DocumentSummary>();
  sets = new Map<string, Decoration[]>();
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

/** A git that answers from tables and records what it was asked. */
class FakeGit implements GitHost {
  changes: FileChanges = { state: "clean", hunks: [] };
  blames = new Map<number, Blame>();
  asked: string[] = [];

  async fileChanges(path: string): Promise<FileChanges> {
    this.asked.push(`changes ${path}`);
    return this.changes;
  }

  async blameLine(path: string, line: number): Promise<Blame | null> {
    this.asked.push(`blame ${path}:${line}`);
    return this.blames.get(line) ?? null;
  }
}

interface Setup {
  host: RecordingHost;
  git: FakeGit;
  editor: EditorService;
  gutter: GitGutterService;
}

/** The gutter service over a recording editor and a fake git, with a short pause before blame. */
async function setUp(): Promise<Setup> {
  const root = new RootContext();
  const host = new RecordingHost();
  const git = new FakeGit();
  let editor!: EditorService;
  let gutter!: GitGutterService;
  await root.plugin({
    name: "git-gutter-test",
    apply: (ctx: Context) => {
      const layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, host, layout);
      gutter = new GitGutterService(ctx, editor, git, { now: () => NOW, blameDelayMs: 5 });
    },
  });
  return { host, git, editor, gutter };
}

const ada: Blame = { hash: "abc", author: "Ada", time: (NOW - DAY_MS) / 1000, summary: "First", committed: true };

describe("the git gutter service", () => {
  test("a file that is opened gets bars for its hunks and blame for its first line", async () => {
    const { host, git, editor } = await setUp();
    git.changes = { state: "changed", hunks: [{ oldStart: 1, oldCount: 1, newStart: 2, newCount: 1 }] };
    git.blames.set(1, ada);
    await editor.openPath("/repo/a.rs");
    host.emit({ type: "opened", summary: host.documents.get("/repo/a.rs") as DocumentSummary });
    await settle(10);
    expect(host.sets.get(`1/${CHANGES_SOURCE}`)).toEqual([
      { kind: "gutter", start: { row: 1, column: 0 }, end: { row: 1, column: 0 }, mark: "bar", tone: "modified" },
    ]);
    const blame = host.sets.get(`1/${BLAME_SOURCE}`) as Decoration[];
    expect(blame[0]).toMatchObject({ kind: "line_end", start: { row: 0 }, text: "Ada, 1 day ago • First" });
  });

  test("blame follows the cursor, once it has stopped for a moment", async () => {
    const { host, git, editor } = await setUp();
    git.blames.set(1, ada);
    git.blames.set(6, { ...ada, author: "Grace", summary: "Sixth" });
    await editor.openPath("/repo/a.rs");
    host.emit({ type: "opened", summary: host.documents.get("/repo/a.rs") as DocumentSummary });
    await settle(10);
    git.asked.length = 0;
    for (const row of [1, 2, 3, 4, 5]) {
      host.emit({ type: "selections", id: 1, row, column: 0, count: 1, selected: false });
    }
    await settle(30);
    expect(git.asked).toEqual(["blame /repo/a.rs:6"]);
    const blame = host.sets.get(`1/${BLAME_SOURCE}`) as Decoration[];
    expect(blame[0]).toMatchObject({ start: { row: 5 }, text: "Grace, 1 day ago • Sixth" });
  });

  test("a file with unsaved changes loses its blame when the cursor moves, and gets it back on save", async () => {
    const { host, git, editor } = await setUp();
    git.blames.set(1, ada);
    git.blames.set(3, ada);
    await editor.openPath("/repo/a.rs");
    host.emit({ type: "opened", summary: host.documents.get("/repo/a.rs") as DocumentSummary });
    await settle(10);
    expect(host.sets.has(`1/${BLAME_SOURCE}`)).toBe(true);
    host.emit({ type: "dirty", id: 1, dirty: true });
    host.emit({ type: "selections", id: 1, row: 2, column: 0, count: 1, selected: false });
    await settle(30);
    expect(host.sets.has(`1/${BLAME_SOURCE}`)).toBe(false);
    host.emit({ type: "dirty", id: 1, dirty: false });
    await settle(10);
    expect(host.sets.get(`1/${BLAME_SOURCE}`)).toBeDefined();
  });

  test("saving reads the diff again and drops bars that are gone", async () => {
    const { host, git, editor } = await setUp();
    git.changes = { state: "changed", hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 }] };
    await editor.openPath("/repo/a.rs");
    host.emit({ type: "opened", summary: host.documents.get("/repo/a.rs") as DocumentSummary });
    await settle(10);
    expect(host.sets.has(`1/${CHANGES_SOURCE}`)).toBe(true);
    git.changes = { state: "clean", hunks: [] };
    host.emit({ type: "saved", id: 1 });
    await settle(10);
    expect(host.sets.has(`1/${CHANGES_SOURCE}`)).toBe(false);
  });

  test("a slow answer for an old request does not replace a newer one", async () => {
    const { host, git, editor } = await setUp();
    await editor.openPath("/repo/a.rs");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale: FileChanges = { state: "changed", hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 }] };
    const fresh: FileChanges = { state: "clean", hunks: [] };
    const answers = [held.then(() => stale), Promise.resolve(fresh)];
    git.fileChanges = async () => answers.shift() as Promise<FileChanges>;
    host.emit({ type: "saved", id: 1 });
    host.emit({ type: "saved", id: 1 });
    await settle(5);
    release();
    await settle(10);
    expect(host.sets.has(`1/${CHANGES_SOURCE}`)).toBe(false);
  });

  test("git failing leaves a file without bars instead of an error", async () => {
    const { host, git, editor } = await setUp();
    git.fileChanges = async () => {
      throw new Error("git is not installed");
    };
    await editor.openPath("/repo/a.rs");
    host.emit({ type: "saved", id: 1 });
    await settle(10);
    expect(host.sets.has(`1/${CHANGES_SOURCE}`)).toBe(false);
  });
});
