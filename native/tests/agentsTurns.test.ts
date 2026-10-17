import { expect, test } from "bun:test";
import type { Component, SessionEvent, ViewItem } from "@suite/protocol/types";
import { applyCall, chainedTexts, noCalls, type CallFacts, type Calls } from "../plugins/agents/calls";
import { argumentOf, shortDirectory } from "../plugins/agents/chat/callRow";
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
  return { fold: true, callOf: (ref) => calls.byRef.get(ref), running, isOpen: (key) => open.includes(key) };
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
  expect(chatRows(items, factsOf(calls, true)).map((row) => row.kind)).toEqual(["item", "item", "item", "working"]);
  expect(chatRows(items, factsOf(calls, false)).map((row) => row.kind)).toEqual(["item", "turn", "item"]);
});

test("only the last section is in flight while a turn runs", () => {
  const calls = callsOf([started("r", "read"), started("s", "read")]);
  const items = [user("u1"), tool("r"), agent("m1"), user("u2"), tool("s")];
  expect(chatRows(items, factsOf(calls, true)).map((row) => row.kind)).toEqual(["item", "turn", "item", "item", "item", "working"]);
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
  expect(rows[2]).toMatchObject({ kind: "run", key: "run:c-r1", foldKey: "run:c-r1", open: false });
  expect(rows[1]).toMatchObject({ kind: "turn", key: "turn:u1", foldKey: "u1", open: true });
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

test("a chat that does not fold shows every item as it is", () => {
  const calls = callsOf([started("r", "read")]);
  const items = [user("u1"), tool("r"), agent("m1")];
  const facts = { ...factsOf(calls), fold: false };
  expect(chatRows(items, facts).map((row) => row.kind)).toEqual(["item", "item", "item"]);
});

test("no two rows share a key, so the list can tell them apart", () => {
  const calls = callsOf([started("r", "read"), started("e", "edit")]);
  const items = [user("u1"), tool("r"), tool("e", "done", diff), agent("m1"), user("u2"), agent("m2")];
  const keys = chatRows(items, factsOf(calls, true)).map((row) => row.key);
  expect(new Set(keys).size).toBe(keys.length);
  const settled = chatRows(items, factsOf(calls)).map((row) => row.key);
  expect(new Set(settled).size).toBe(settled.length);
});

test("the plan item folds with the work, since the plan has its own place", () => {
  const plan: ViewItem = { ref: "plan", kind: "tool", label: "Plan", state: "done", component: text("[x] one") };
  const fold = foldTurn([plan, agent("m1")], () => undefined);
  expect(fold.hidden.map((item) => item.ref)).toEqual(["plan"]);
});

test("changes to a file add up to one when each starts where the one before ended", () => {
  expect(chainedTexts([])).toBeUndefined();
  expect(chainedTexts([{ path: "a", oldText: "1", newText: "2" }, { path: "a", oldText: "2", newText: "3" }])).toEqual({ oldText: "1", newText: "3" });
  expect(chainedTexts([{ path: "a", newText: "2" }])).toEqual({ oldText: "", newText: "2" });
  expect(chainedTexts([{ path: "a", oldText: "1", newText: "2" }, { path: "a", oldText: "x", newText: "3" }])).toBeUndefined();
});

const callWith = (fields: Partial<CallFacts>): CallFacts => ({ id: "x", ref: "c-x", kind: "other", title: "A title", status: "completed", diffs: [], ...fields });

test("a call's line names the file it was about, with where it is, or else its command or search", () => {
  expect(argumentOf(callWith({ kind: "read", rawInput: { path: "/repo/src/util.ts" } }))).toEqual({ text: "util.ts", path: "/repo/src/util.ts", directory: "/repo/src/" });
  expect(argumentOf(callWith({ rawInput: { file_path: "/a/b/c/d.ts" } }))).toEqual({ text: "d.ts", path: "/a/b/c/d.ts", directory: "…/b/c/" });
  expect(argumentOf(callWith({ kind: "edit", diffs: [{ path: "/repo/x.md", newText: "" }] }))).toMatchObject({ text: "x.md", path: "/repo/x.md" });
  expect(argumentOf(callWith({ kind: "execute", rawInput: { command: "bun   test\n--bail" } }))).toEqual({ text: "bun test --bail" });
  expect(argumentOf(callWith({ kind: "search", rawInput: { pattern: "greet" } }))).toEqual({ text: "greet" });
  expect(argumentOf(callWith({ rawInput: {} }))).toEqual({ text: "A title" });
  expect(shortDirectory("name.txt")).toBeUndefined();
});

test("the daemon's notices about apps connecting and the agent moving are left out of the chat, other notices stay", () => {
  const items = [notice("n1"), user("u1"), agent("m1")];
  const connected: ViewItem = { ref: "n2", kind: "notice", component: text("grove connected (v0): ") };
  const moved: ViewItem = { ref: "n3", kind: "notice", component: text("now in grove cwd=/repo") };
  const rows = chatRows([connected, moved, ...items], factsOf(noCalls()));
  expect(rows.map((row) => row.key)).toEqual(["n1", "u1", "m1"]);
});
