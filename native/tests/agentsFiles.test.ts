import { describe, expect, test } from "bun:test";
import type { DiffLine, SessionEvent } from "@suite/protocol/types";
import type { DiffFile, Worktree } from "../../src/shared/types";
import { ChatSession } from "../plugins/agents/chatSession";
import { sidecarChanges } from "../plugins/agents/changesSource";
import { FilesModel, type ChangesSource } from "../plugins/agents/filesModel";
import { worktree } from "./support/agentsSetup";
import { FakeClient } from "./support/fakeSuite";

/** A changes source answering from tables, which records what it was asked. */
class FakeChanges implements ChangesSource {
  files: DiffFile[] = [{ path: "src/a.ts", changeType: "modified", staged: false }];
  lines: DiffLine[] = [{ kind: "add", text: "x", new: 1 }];
  failing: string | null = null;
  asked: string[] = [];

  async changedFiles(worktreeId: string): Promise<DiffFile[]> {
    this.asked.push(`changes ${worktreeId}`);
    if (this.failing !== null) {
      throw new Error(this.failing);
    }
    return this.files;
  }

  async diffLines(worktreeId: string, file: DiffFile): Promise<DiffLine[]> {
    this.asked.push(`diff ${worktreeId} ${file.path}`);
    if (this.failing !== null) {
      throw new Error(this.failing);
    }
    return this.lines;
  }
}

interface Setup {
  source: FakeChanges;
  chat: ChatSession;
  model: FilesModel;
  emit: (event: SessionEvent) => void;
}

/** A files model for a session working in `directory`, over the repository's two worktrees. */
function setUp(directory: string | undefined): Setup {
  const source = new FakeChanges();
  const client = new FakeClient();
  const chat = new ChatSession(client as never, "s", () => undefined);
  chat.start();
  const worktrees: Worktree[] = [worktree("main", "/repo", true), worktree("feature", "/repo/.worktrees/feature")];
  const model = new FilesModel(source, () => worktrees, chat, () => directory);
  return { source, chat, model, emit: (event) => client.events[0].emit(event) };
}

describe("the worktree a session works in", () => {
  test("is the one holding its directory, the innermost when several do", () => {
    expect(setUp("/repo").model.worktree()?.id).toBe("main");
    expect(setUp("/repo/src").model.worktree()?.id).toBe("main");
    expect(setUp("/repo/.worktrees/feature").model.worktree()?.id).toBe("feature");
    expect(setUp("/repo/.worktrees/feature/src").model.worktree()?.id).toBe("feature");
  });

  test("is none for a directory outside them, or while the session is unknown", () => {
    expect(setUp("/elsewhere").model.worktree()).toBeNull();
    expect(setUp("/repository").model.worktree()).toBeNull();
    expect(setUp(undefined).model.worktree()).toBeNull();
  });
});

describe("the files panel's entries", () => {
  test("list what git reports and what the agents touched, tagged", async () => {
    const { model, emit } = setUp("/repo");
    await model.refresh();
    emit({ type: "tool_call_update", toolCallId: "t", content: [{ type: "diff", path: "/repo/src/a.ts", newText: "" }] });
    emit({ type: "tool_call_update", toolCallId: "u", content: [{ type: "diff", path: "/repo/notes.md", newText: "" }] });
    expect(model.entries().map((entry) => [entry.rel, entry.mark, entry.tags])).toEqual([
      ["src/a.ts", "modified", ["agent"]],
      ["notes.md", "clean", ["agent"]],
    ]);
  });

  test("ask git for the session's worktree, and none at all outside one", async () => {
    const inside = setUp("/repo/.worktrees/feature");
    await inside.model.refresh();
    expect(inside.source.asked).toEqual(["changes feature"]);
    const outside = setUp("/elsewhere");
    await outside.model.refresh();
    expect(outside.source.asked).toEqual([]);
    expect(outside.model.entries()).toEqual([]);
  });

  test("keep the touched files when git cannot answer", async () => {
    const { model, source, emit } = setUp("/repo");
    source.failing = "git is gone";
    emit({ type: "tool_call_update", toolCallId: "t", content: [{ type: "diff", path: "/repo/a.ts", newText: "" }] });
    await model.refresh();
    expect(model.entries().map((entry) => entry.rel)).toEqual(["a.ts"]);
  });

  test("a refresh asked for while one runs is run once more after it", async () => {
    const { model, source } = setUp("/repo");
    await Promise.all([model.refresh(), model.refresh(), model.refresh()]);
    expect(source.asked).toEqual(["changes main", "changes main"]);
  });
});

describe("a file's diff", () => {
  test("opens in place of the list and closes back to it", async () => {
    const { model } = setUp("/repo");
    await model.refresh();
    const [entry] = model.entries();
    expect(model.canDiff(entry)).toBe(true);
    await model.showDiff(entry);
    expect(model.diff()).toEqual({ path: "src/a.ts", lines: [{ kind: "add", text: "x", new: 1 }] });
    model.closeDiff();
    expect(model.diff()).toBeNull();
  });

  test("says so when the file has nothing to show", async () => {
    const { model, source } = setUp("/repo");
    await model.refresh();
    source.lines = [];
    await model.showDiff(model.entries()[0]);
    expect(model.diff()?.lines).toEqual([{ kind: "context", text: "no changes to show" }]);
  });

  test("a file only an agent touched has none", async () => {
    const { model, emit } = setUp("/repo");
    emit({ type: "tool_call_update", toolCallId: "t", content: [{ type: "diff", path: "/repo/gone.md", newText: "" }] });
    const [entry] = model.entries();
    expect(model.canDiff(entry)).toBe(false);
    await model.showDiff(entry);
    expect(model.diff()).toBeNull();
  });

  test("a file the agent touched and git sees no change in shows what the agent's calls changed", async () => {
    const { model, emit } = setUp("/repo");
    emit({ type: "tool_call", toolCallId: "t", title: "Edit", kind: "edit", status: "pending" });
    emit({
      type: "tool_call_update",
      toolCallId: "t",
      content: [{ type: "diff", path: "/repo/gone.md", oldText: "one\ntwo\n", newText: "one\n2\n" }],
    });
    const [entry] = model.entries();
    expect(model.canDiff(entry)).toBe(true);
    await model.showDiff(entry);
    expect(model.diff()?.path).toBe("gone.md");
    expect(model.diff()?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: "one", old: 1, new: 1 },
      { kind: "remove", text: "two", old: 2 },
      { kind: "add", text: "2", new: 2 },
    ]);
  });

  test("a failure to read it is kept for the panel to show", async () => {
    const { model, source } = setUp("/repo");
    await model.refresh();
    source.failing = "cannot read";
    await model.showDiff(model.entries()[0]);
    expect(model.diff()).toBeNull();
    expect(model.error()).toBe("cannot read");
  });
});

describe("the sidecar as the source", () => {
  test("lists a worktree's changes and turns a file's two sides into diff lines", async () => {
    const calls: string[] = [];
    const source = sidecarChanges({
      async call<Result>(channel: string, ...args: unknown[]): Promise<Result> {
        calls.push(`${channel} ${String(args[0])}`);
        if (channel === "git:changedFiles") {
          return [{ path: "a.ts", changeType: "modified", staged: false }] as Result;
        }
        if (channel === "git:diffSides") {
          return { path: "a.ts", original: "one\n", modified: "two\n", language: "typescript" } as Result;
        }
        expect(args.slice(1)).toEqual(["one\n", "two\n"]);
        return "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-one\n+two\n" as Result;
      },
    });
    expect(await source.changedFiles("w")).toHaveLength(1);
    expect(await source.diffLines("w", { path: "a.ts", changeType: "modified", staged: false })).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "remove", text: "one", old: 1 },
      { kind: "add", text: "two", new: 1 },
    ]);
    expect(calls).toEqual(["git:changedFiles w", "git:diffSides w", "git:diffText w"]);
  });
});
