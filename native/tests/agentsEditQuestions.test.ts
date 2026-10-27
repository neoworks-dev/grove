import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventRecord } from "@suite/protocol/types";
import { showEditQuestion, type EditDiffOpener } from "../plugins/agents/editDiffs";
import { applyEditQuestion, editQuestionOf, type EditQuestion, type EditQuestions } from "../plugins/agents/editQuestions";
import type { Prompt } from "../plugins/agents/prompt";

/** An event as the record of a session's log. */
function record(event: unknown, seq: number): SessionEventRecord {
  return { session: "s", seq, ts: 1000, event: event as SessionEvent };
}

/** A permission request about an edit of `/repo/a.ts`, with the options the daemon gives it. */
function editRequest(id: string, options: string[]): unknown {
  return {
    type: "permission_request",
    id,
    agent: "neo",
    title: "Edit a.ts",
    kind: "edit",
    content: [{ type: "diff", path: "/repo/a.ts", oldText: "one\n", newText: "two\n" }],
    options: options.map((option) => ({ id: option, name: option, kind: "allow_once" })),
  };
}

/** The questions after folding events in from none. */
function fold(events: unknown[]): EditQuestions {
  let questions: EditQuestions = new Map();
  events.forEach((event, index) => {
    questions = applyEditQuestion(questions, record(event, index + 1));
  });
  return questions;
}

describe("the edit questions", () => {
  test("a request with a diff waits until it is resolved", () => {
    const asked = fold([editRequest("p1", ["allow", "reject"])]);
    expect(asked.get("p1")).toEqual({
      id: "p1",
      written: false,
      diffs: [{ path: "/repo/a.ts", oldText: "one\n", newText: "two\n" }],
    });
    const answered = fold([editRequest("p1", ["allow", "reject"]), { type: "permission_resolved", id: "p1", option: "allow" }]);
    expect(answered.size).toBe(0);
  });

  test("a Keep or Revert question is about an edit that is written already", () => {
    expect(fold([editRequest("p1", ["keep", "revert"])]).get("p1")?.written).toBe(true);
  });

  test("a request to run a command is not an edit", () => {
    const questions = fold([{ type: "permission_request", id: "p1", agent: "neo", title: "ls", kind: "execute", content: [{ type: "text", text: "ls" }], options: [] }]);
    expect(questions.size).toBe(0);
  });

  test("a prompt finds its edit by the request id its buttons answer with", () => {
    const questions = fold([editRequest("p1", ["keep", "revert"])]);
    const prompt: Prompt = {
      ref: "q1",
      title: "Edited a.ts, keep it?",
      body: [],
      buttons: [{ label: "Keep", action: "neo.permit", args: { id: "p1", option: "keep" }, current: false }],
    };
    expect(editQuestionOf(prompt, questions)?.id).toBe("p1");
    expect(editQuestionOf({ ...prompt, buttons: [{ label: "Ok", action: "neo.choose", args: { id: "c1" }, current: false }] }, questions)).toBeUndefined();
    expect(editQuestionOf(undefined, questions)).toBeUndefined();
  });
});

/** A diff opener that records what it was asked to do. */
function recordingOpener(existingPanes: string[] = []): EditDiffOpener & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    showInEditor: async (path, base) => {
      calls.push(`inline ${path} against ${base.text.trim()}`);
      return true;
    },
    hideFromFile: async (path) => {
      calls.push(`hide ${path}`);
    },
    openTexts: async (name, oldText, newText) => {
      calls.push(`texts ${name} ${oldText.trim()}>${newText.trim()}`);
      return "diff-1";
    },
    closePane: (leafId) => {
      calls.push(`close ${leafId}`);
    },
    diffPaneIds: () => existingPanes,
  };
}

const question = (written: boolean): EditQuestion => ({
  id: "p1",
  written,
  diffs: [{ path: "/repo/a.ts", oldText: "one\n", newText: "two\n" }],
});

describe("showing an edit question", () => {
  test("an edit not written yet is a diff pane of the two texts, closed again afterwards", async () => {
    const diff = recordingOpener();
    const shown = showEditQuestion(diff, question(false));
    await shown.opened;
    shown.close();
    await Promise.resolve();
    expect(diff.calls).toEqual(["texts a.ts one>two", "close diff-1"]);
  });

  test("a written edit is drawn over the file, and taken off it afterwards", async () => {
    const diff = recordingOpener();
    const shown = showEditQuestion(diff, question(true));
    await shown.opened;
    shown.close();
    await Promise.resolve();
    expect(diff.calls).toEqual(["inline /repo/a.ts against one", "hide /repo/a.ts"]);
  });

  test("a diff pane that was open before stays open", async () => {
    const diff = recordingOpener(["diff-1"]);
    const shown = showEditQuestion(diff, question(false));
    await shown.opened;
    shown.close();
    await Promise.resolve();
    expect(diff.calls).toEqual(["texts a.ts one>two"]);
  });
});
