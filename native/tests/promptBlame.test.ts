import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import type { LineBlame, PromptAttribution } from "../../src/shared/agents";
import { EditorService } from "../plugins/editor/service";
import { LayoutService } from "../plugins/layout/service";
import type { PromptBlameHost } from "../plugins/prompt-blame/blameHost";
import { PROMPT_BLAME_SOURCE, promptHeadline, promptLabel } from "../plugins/prompt-blame/label";
import { PromptBlameService } from "../plugins/prompt-blame/service";
import { FakeDocuments } from "./support/fakeDiffHost";
import { settle } from "./support/fakeSidecar";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/** A prompt as the sidecar reports it, with only what a test cares about changed. */
function attribution(changes: Partial<PromptAttribution> = {}): PromptAttribution {
  return {
    sessionId: "s1",
    sessionTitle: "Greeter work",
    harness: "claude",
    turnSeq: 1,
    stepIndex: 0,
    from: "You",
    prompt: "Write a greet function.\nKeep it small.",
    at: "2026-10-16T09:50:00.000Z",
    explanation: "",
    reasoning: "",
    sessionExists: true,
    ...changes,
  };
}

const commit = { sha: "abc1234", author: "Ada", time: NOW - 3 * DAY_MS, summary: "Add the greeter" };

describe("how a blamed line reads", () => {
  test("the agent's own explanation comes first, then the commit", () => {
    const blame: LineBlame = { commit, prompt: attribution({ explanation: "Adds greet, which builds the hello message." }) };
    expect(promptLabel(blame, NOW)).toBe("✦ Adds greet, which builds the hello message.  ·  Ada, 3 days ago · Add the greeter");
  });

  test("without an explanation it is the first line of the prompt that wrote the line", () => {
    const blame: LineBlame = { commit, prompt: attribution() };
    expect(promptLabel(blame, NOW)).toBe("✦ “Write a greet function.”  ·  Ada, 3 days ago · Add the greeter");
  });

  test("a prompt that is long is cut, and an empty one gives way to the session's title", () => {
    expect(promptHeadline("x".repeat(80), 20)).toBe(`${"x".repeat(19)}…`);
    const blame: LineBlame = { commit: null, prompt: attribution({ prompt: "  " }) };
    expect(promptLabel(blame, NOW)).toBe("✦ “Greeter work”  ·  uncommitted");
  });

  test("a line no prompt wrote has no label", () => {
    expect(promptLabel({ commit, prompt: null }, NOW)).toBeNull();
  });
});

/** Answers from a table of lines, and records what it was asked. */
class FakeBlame implements PromptBlameHost {
  byLine = new Map<number, LineBlame>();
  asked: string[] = [];
  /** When set, the next answer waits for it. */
  hold: Promise<void> | null = null;

  async blameLine(worktreeId: string, path: string, line: number, text: string): Promise<LineBlame> {
    this.asked.push(`${worktreeId} ${path}:${line} ${text}`);
    const held = this.hold;
    this.hold = null;
    if (held) {
      await held;
    }
    return this.byLine.get(line) ?? { commit: null, prompt: null };
  }
}

/** The service over a fake editor with `/repo/a.ts` open, and a short pause before it looks up. */
async function setUp() {
  const root = new RootContext();
  const documents = new FakeDocuments();
  documents.files.set("/repo/a.ts", "first\nsecond\nthird\n");
  documents.files.set("/elsewhere/b.ts", "other\n");
  const blame = new FakeBlame();
  let editor!: EditorService;
  await root.plugin({
    name: "prompt-blame-test",
    apply: (ctx: Context) => {
      const layout = new LayoutService(ctx, "editor", null);
      editor = new EditorService(ctx, documents, layout);
      const workspace = { selectedWorktree: () => ({ id: "main", path: "/repo" }) };
      new PromptBlameService(ctx, editor, blame, workspace, { now: () => NOW, restDelayMs: 5 });
    },
  });
  const id = (await editor.openPath("/repo/a.ts")) as number;
  return { documents, blame, editor, id };
}

/** Moves the cursor of a document to a row, as the host reports it. */
function moveTo(documents: FakeDocuments, id: number, row: number): void {
  documents.emit({ type: "selections", id, row, column: 0, count: 1, selected: false });
}

describe("the prompt blame service", () => {
  test("a line an agent wrote shows its prompt at the end once the cursor rests on it", async () => {
    const { documents, blame, id } = await setUp();
    blame.byLine.set(2, { commit, prompt: attribution({ explanation: "Says the second thing." }) });
    moveTo(documents, id, 1);
    await settle(30);
    expect(blame.asked.at(-1)).toBe("main /repo/a.ts:2 second");
    const shown = documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`);
    expect(shown).toEqual([
      {
        kind: "line_end",
        start: { row: 1, column: 1_000_000 },
        text: "✦ Says the second thing.  ·  Ada, 3 days ago · Add the greeter",
        tone: "line_end",
      },
    ]);
  });

  test("the text is gone as soon as the cursor moves, and a line a person wrote gets none", async () => {
    const { documents, blame, id } = await setUp();
    blame.byLine.set(2, { commit, prompt: attribution() });
    moveTo(documents, id, 1);
    await settle(30);
    expect(documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`)).toHaveLength(1);
    moveTo(documents, id, 2);
    await Promise.resolve();
    await settle(1);
    expect(documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`)).toEqual([]);
    await settle(30);
    expect(documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`)).toEqual([]);
  });

  test("a cursor that keeps moving asks about the line it stops on only", async () => {
    const { documents, blame, id } = await setUp();
    for (const row of [0, 1, 2]) {
      moveTo(documents, id, row);
    }
    await settle(30);
    expect(blame.asked).toEqual(["main /repo/a.ts:3 third"]);
  });

  test("an answer for a line the cursor has left is dropped", async () => {
    const { documents, blame, id } = await setUp();
    let release!: () => void;
    blame.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    blame.byLine.set(1, { commit, prompt: attribution() });
    moveTo(documents, id, 0);
    await settle(30);
    moveTo(documents, id, 2);
    release();
    await settle(30);
    expect(documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`)).toBeUndefined();
  });

  test("unsaved changes, and files outside the worktree, are not looked up", async () => {
    const { documents, blame, editor, id } = await setUp();
    blame.byLine.set(1, { commit, prompt: attribution() });
    documents.emit({ type: "dirty", id, dirty: true });
    moveTo(documents, id, 0);
    await settle(30);
    expect(blame.asked).toEqual([]);
    const outside = (await editor.openPath("/elsewhere/b.ts")) as number;
    moveTo(documents, outside, 0);
    await settle(30);
    expect(blame.asked).toEqual([]);
  });

  test("a sidecar that fails leaves the line as it was", async () => {
    const { documents, blame, id } = await setUp();
    blame.blameLine = async () => {
      throw new Error("the sidecar is not running");
    };
    moveTo(documents, id, 0);
    await settle(30);
    expect(documents.decorations.get(`${id}/${PROMPT_BLAME_SOURCE}`)).toBeUndefined();
  });
});
