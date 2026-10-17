import { expect, test } from "bun:test";
import type { Component, SessionEvent, ViewItem } from "@suite/protocol/types";
import { applyCall, noCalls, type CallFacts, type Calls } from "../plugins/agents/calls";
import { chatRows, foldTurn, talliesOf, toolWord, type ChatFacts } from "../plugins/agents/chat/turns";

const text = (words: string): Component => ({ type: "text", blocks: [{ type: "paragraph", spans: [{ text: words }] }] });
const user = (ref: string): ViewItem => ({ ref, kind: "user", component: text("do it") });
const agent = (ref: string): ViewItem => ({ ref, kind: "agent", component: text("said") });
const thought = (ref: string): ViewItem => ({ ref, kind: "thought", component: text("hm") });
const notice = (ref: string): ViewItem => ({ ref, kind: "notice", component: text("note") });
const diff: Component = {
  type: "diff",
  path: "/repo/src/a.ts",
  lines: [
    { kind: "remove", text: "old", old: 1 },
    { kind: "add", text: "new", new: 1 },
    { kind: "add", text: "newer", new: 2 },
  ],
};
const tool = (id: string, state: ViewItem["state"] = "done", component: Component = text("out")): ViewItem => ({
  ref: `c-${id}`,
  kind: "tool",
  label: id,
  state,
  component,
});

/** The calls the events of these tool calls leave behind. */
function callsOf(events: SessionEvent[]): Calls {
  let calls = noCalls();
  events.forEach((event, index) => {
    calls = applyCall(calls, { session: "s", seq: index + 1, ts: "", event });
  });
  return calls;
}

const started = (id: string, kind: "read" | "execute" | "edit" | "other", rawInput?: unknown, name?: string): SessionEvent => ({
  type: "tool_call",
  toolCallId: id,
  title: id,
  kind,
  status: "pending",
  rawInput,
  tool: name,
});

function factsOf(calls: Calls, running = false, open: string[] = []): ChatFacts {
  return { callOf: (ref) => calls.byRef.get(ref), running, isOpen: (key) => open.includes(key) };
}

test("a call is followed from its start through its updates, keeping what each one carries", () => {
  const calls = callsOf([
    started("a", "edit", { path: "/repo/src/a.ts" }),
    { type: "tool_call_update", toolCallId: "a", status: "in_progress", title: "Edit a.ts" },
    { type: "tool_call_update", toolCallId: "a", status: "completed", content: [{ type: "diff", path: "/repo/src/a.ts", newText: "x" }] },
  ]);
  expect(calls.byRef.get("c-a")).toMatchObject({
    kind: "edit",
    title: "Edit a.ts",
    status: "completed",
    diffs: [{ path: "/repo/src/a.ts", newText: "x" }],
  });
  expect(calls.byRef.get("c-a")?.diffs[0].oldText).toBeUndefined();
});

test("an update for a call nobody started changes nothing", () => {
  const before = noCalls();
  const after = applyCall(before, { session: "s", seq: 1, ts: "", event: { type: "tool_call_update", toolCallId: "ghost", status: "failed" } });
  expect(after).toBe(before);
});

test("a settled turn folds its work into one summary and keeps the answer and what failed", () => {
  const calls = callsOf([started("r", "read", { path: "/repo/src/a.ts" }), started("t", "execute"), started("bad", "execute")]);
  const items = [user("u1"), thought("t1"), agent("m1"), tool("r"), tool("t"), tool("bad", "failed"), agent("m2")];
  const rows = chatRows(items, factsOf(calls));
  expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "item", "item"]);
  expect(rows[2]).toMatchObject({ item: { ref: "c-bad" } });
  expect(rows[3]).toMatchObject({ item: { ref: "m2" } });
  expect(rows[1]).toMatchObject({ kind: "turn", open: false, messages: 1, tallies: [{ name: "read", count: 1, files: ["a.ts"] }, { name: "shell", count: 1 }] });
});

test("the turn that is running keeps every item as it is", () => {
  const calls = callsOf([started("r", "read")]);
  const items = [user("u1"), tool("r"), agent("m1")];
  expect(chatRows(items, factsOf(calls, true)).map((row) => row.kind)).toEqual(["item", "item", "item"]);
  expect(chatRows(items, factsOf(calls, false)).map((row) => row.kind)).toEqual(["item", "turn", "item"]);
});

test("only the last section is in flight while a turn runs", () => {
  const calls = callsOf([started("r", "read"), started("s", "read")]);
  const items = [user("u1"), tool("r"), agent("m1"), user("u2"), tool("s")];
  expect(chatRows(items, factsOf(calls, true)).map((row) => row.kind)).toEqual(["item", "turn", "item", "item", "item"]);
});

test("a turn with no answer folds nothing", () => {
  const calls = callsOf([started("r", "read")]);
  expect(foldTurn([tool("r")], (ref) => calls.byRef.get(ref)).hidden).toEqual([]);
});

test("messages with no settled call between them are all the answer", () => {
  const calls = callsOf([started("r", "read")]);
  const fold = foldTurn([agent("m1"), tool("r"), agent("m2"), agent("m3")], (ref) => calls.byRef.get(ref));
  expect(fold.hidden.map((item) => item.ref)).toEqual(["m1", "c-r"]);
  expect(fold.kept.map((item) => item.ref)).toEqual(["m2", "m3"]);
});

test("a folded turn lists the files it changed once, with the lines of every change counted", () => {
  const calls = callsOf([
    started("e1", "edit"),
    { type: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "old", newText: "new" }] },
    started("e2", "edit"),
    { type: "tool_call_update", toolCallId: "e2", status: "completed", content: [{ type: "diff", path: "/repo/src/a.ts", newText: "new" }] },
  ]);
  const items = [user("u1"), tool("e1", "done", diff), tool("e2", "done", diff), agent("m1")];
  const rows = chatRows(items, factsOf(calls));
  expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "files", "item"]);
  expect(rows[2]).toMatchObject({ files: [{ path: "/repo/src/a.ts", added: 4, removed: 2, created: false }] });
  expect(rows[1]).toMatchObject({ tallies: [] });
});

test("an opened turn shows its items, with runs of settled calls folded to a line", () => {
  const calls = callsOf([started("r1", "read"), started("r2", "read"), started("g", "other")]);
  const items = [user("u1"), tool("r1"), tool("r2"), agent("m1"), tool("g"), agent("m2")];
  const rows = chatRows(items, factsOf(calls, false, ["u1"]));
  expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "run", "item", "item", "item"]);
  expect(rows[2]).toMatchObject({ kind: "run", key: "run:c-r1", open: false });
});

test("a call's word is its tool without the server it came from, else its kind", () => {
  const word = (call: Partial<CallFacts>): string => toolWord({ id: "x", ref: "c-x", kind: "other", title: "", status: "completed", diffs: [], ...call });
  expect(word({ tool: "mcp__grove__read" })).toBe("read");
  expect(word({ tool: "bash" })).toBe("bash");
  expect(word({ kind: "execute" })).toBe("shell");
  expect(word({ kind: "search" })).toBe("search");
});

test("tallies count calls by tool and name the files they read once", () => {
  const calls = callsOf([started("a", "read", { path: "/x/a.ts" }), started("b", "read", { file_path: "/y/a.ts" }), started("c", "read", { filePath: "b.ts" })]);
  expect(talliesOf([tool("a"), tool("b"), tool("c")], (ref) => calls.byRef.get(ref))).toEqual([{ name: "read", count: 3, files: ["a.ts", "b.ts"] }]);
});
