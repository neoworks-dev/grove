import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventRecord } from "@suite/protocol/types";
import { fileEntries, glyphOfMark, relativize, type Touched } from "../plugins/agents/files";
import { applyPlan, glyphOf, ownFirst, progress } from "../plugins/agents/plan";
import { SessionFacts } from "../plugins/agents/sessionFacts";
import { APPROVALS, nextApprovals } from "../plugins/agents/status";
import { activityOf, compact, dirLabel, elapsed, modelLabel, shownAgents, LINGER_MS } from "../plugins/agents/subagents";
import { parseUnified } from "../plugins/agents/unified";
import { sessionInfo } from "./support/fakeSuite";
import { settle } from "./support/fakeSidecar";
import { setUpAgents } from "./support/agentsSetup";

/** An event as the record of a session's log. */
function record(event: SessionEvent, seq: number, ts = 1000): SessionEventRecord {
  return { session: "s", seq, ts, event };
}

describe("approvals", () => {
  test("Shift-Tab goes ask, review, edits, auto and round again", () => {
    expect(APPROVALS).toEqual(["ask", "review", "edits", "auto"]);
    expect(nextApprovals("ask")).toBe("review");
    expect(nextApprovals("edits")).toBe("auto");
    expect(nextApprovals("auto")).toBe("ask");
  });
});

describe("the session facts", () => {
  test("a user message starts a turn, its end stops it, and the suite's approvals setting is kept", () => {
    const facts = new SessionFacts();
    facts.apply(record({ type: "user_message", text: "hi" } as SessionEvent, 1));
    expect(facts.status.running).toBe(true);
    facts.apply(record({ type: "setting_changed", harness: "suite", option: "approvals", value: "edits" }, 2));
    expect(facts.status.approvals).toBe("edits");
    facts.apply(record({ type: "setting_changed", harness: "suite", option: "approvals", value: "nonsense" }, 3));
    expect(facts.status.approvals).toBe("edits");
    facts.apply(record({ type: "turn_ended", stopReason: "end_turn" }, 4));
    expect(facts.status.running).toBe(false);
  });

  test("an event that changes nothing reports no change", () => {
    const facts = new SessionFacts();
    expect(facts.apply(record({ type: "agent_message_chunk", text: "x" } as SessionEvent, 1))).toBe(false);
  });

  test("a replay from the start begins the fold again", () => {
    const facts = new SessionFacts();
    facts.apply(record({ type: "plan", entries: [{ content: "a", status: "pending" }] }, 1));
    facts.apply(record({ type: "plan", agent: "claude", entries: [{ content: "b", status: "pending" }] }, 2));
    expect(facts.plans).toHaveLength(2);
    facts.apply(record({ type: "plan", entries: [{ content: "a", status: "pending" }] }, 1));
    expect(facts.plans).toHaveLength(1);
  });
});

describe("the plan", () => {
  test("each plan event replaces that agent's list and an empty one clears it", () => {
    let lists = applyPlan([], { type: "plan", entries: [{ content: "one", status: "pending" }] });
    lists = applyPlan(lists, { type: "plan", agent: "claude", entries: [{ content: "g", status: "in_progress" }] });
    lists = applyPlan(lists, { type: "plan", entries: [{ content: "one", status: "completed" }, { content: "two", status: "pending" }] });
    expect(lists.map((list) => [list.agent, list.items.length])).toEqual([[undefined, 2], ["claude", 1]]);
    expect(progress(lists)).toEqual({ done: 1, total: 3 });
    lists = applyPlan(lists, { type: "plan", agent: "claude", entries: [] });
    expect(lists.map((list) => list.agent)).toEqual([undefined]);
  });

  test("the session's own list comes first, and each status has a mark", () => {
    const lists = [{ agent: "claude", items: [] }, { items: [] }];
    expect(ownFirst(lists).map((list) => list.agent)).toEqual([undefined, "claude"]);
    expect([glyphOf("completed"), glyphOf("in_progress"), glyphOf("pending")]).toEqual(["✓", "◐", "○"]);
  });
});

describe("the agents list", () => {
  const started: SessionEvent = { type: "subagent_started", id: "a1", agent: "claude", task: "fix it", model: "anthropic/opus" };

  test("a delegation runs, shows its latest tool call and tokens, and ends", () => {
    const facts = new SessionFacts();
    facts.apply(record(started, 1, 1000));
    expect(facts.agents[0]).toMatchObject({ id: "a1", harness: "claude", state: "running", activity: "starting…" });
    facts.apply(record({ type: "tool_call", toolCallId: "t", title: "Edit a.ts", kind: "edit", status: "pending", agent: "claude" }, 2));
    facts.apply(record({ type: "usage", agent: "claude", inputTokens: 1200, outputTokens: 300 }, 3));
    expect(facts.agents[0]).toMatchObject({ activity: "Edit a.ts", tokens: 1500 });
    facts.apply(record({ type: "subagent_ended", id: "a1", stopReason: "end_turn" }, 4, 6000));
    expect(facts.agents[0]).toMatchObject({ state: "done", endedMs: 6000 });
  });

  test("a turn that ends under a running delegation interrupts it", () => {
    const facts = new SessionFacts();
    facts.apply(record(started, 1));
    facts.apply(record({ type: "turn_ended", stopReason: "end_turn" }, 2));
    expect(facts.agents[0]).toMatchObject({ state: "failed", activity: "interrupted" });
  });

  test("a finished agent leaves the list after a few seconds", () => {
    const facts = new SessionFacts();
    facts.apply(record(started, 1));
    facts.apply(record({ type: "subagent_ended", id: "a1", stopReason: "cancelled" }, 2, 2000));
    expect(shownAgents(facts.agents, 2000 + LINGER_MS - 1)).toHaveLength(1);
    expect(shownAgents(facts.agents, 2000 + LINGER_MS)).toHaveLength(0);
  });

  test("an agent with a session of its own shows that session's latest words", () => {
    const facts = new SessionFacts();
    facts.apply(record({ ...started, child: "s2" } as SessionEvent, 1));
    const row = facts.agents[0];
    expect(activityOf(row, [sessionInfo({ id: "s2", preview: "  reading\n the code " })])).toBe("reading the code");
    expect(activityOf(row, [])).toBe("starting…");
  });

  test("durations, token counts and names read short", () => {
    expect([elapsed(5000), elapsed(72_000), elapsed(7_380_000)]).toEqual(["5s", "1m 12s", "2h 03m"]);
    expect([compact(812), compact(3400), compact(1_200_000)]).toEqual(["812", "3.4k", "1.2M"]);
    expect(modelLabel("anthropic/opus")).toBe("opus");
    expect(dirLabel("/repo/.worktrees/feature/")).toBe("feature");
  });
});

describe("the files panel", () => {
  const touch = (path: string, tags: string[]): Touched => ({ path, tags });

  test("git's changes come first, tagged by who touched them, then files only an agent touched", () => {
    const entries = fileEntries(
      "/repo",
      [
        { path: "src/a.ts", changeType: "modified", staged: false },
        { path: "src/a.ts", changeType: "modified", staged: true },
        { path: "new.txt", changeType: "untracked", staged: false },
        { path: "b.ts", oldPath: "old.ts", changeType: "renamed", staged: true },
      ],
      [touch("/repo/src/a.ts", ["agent", "claude"]), touch("/repo/committed.md", ["agent"])],
    );
    expect(entries.map((entry) => [entry.rel, entry.mark, entry.tags])).toEqual([
      ["src/a.ts", "modified", ["agent", "claude"]],
      ["new.txt", "untracked", []],
      ["b.ts", "renamed", []],
      ["committed.md", "clean", ["agent"]],
    ]);
    expect(entries[2].orig).toBe("old.ts");
    expect(entries[3].file).toBeUndefined();
    expect(entries.map((entry) => glyphOfMark(entry.mark))).toEqual(["M", "?", "R", "·"]);
  });

  test("outside a repository only the touched files are listed", () => {
    expect(fileEntries("/repo", undefined, [touch("/repo/a.ts", ["agent"])]).map((entry) => entry.rel)).toEqual(["a.ts"]);
  });

  test("paths are shown relative to the worktree", () => {
    expect(relativize("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativize("/repo", "/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
    expect(relativize("/repo", "./a.ts")).toBe("a.ts");
  });

  test("the diffs of tool calls name the files, and guests tag their own calls", () => {
    const facts = new SessionFacts();
    const diff = (path: string) => [{ type: "diff" as const, path, newText: "x" }];
    facts.apply(record({ type: "tool_call", toolCallId: "own", title: "Edit", kind: "edit", status: "pending" }, 1));
    facts.apply(record({ type: "tool_call", toolCallId: "guest", title: "Edit", kind: "edit", status: "pending", agent: "claude" }, 2));
    facts.apply(record({ type: "tool_call_update", toolCallId: "own", content: diff("/repo/a.ts") }, 3));
    facts.apply(record({ type: "tool_call_update", toolCallId: "guest", content: diff("/repo/a.ts") }, 4));
    facts.apply(record({ type: "tool_call_update", toolCallId: "guest", content: diff("/repo/b.ts") }, 5));
    expect(facts.touches.touched).toEqual([
      { path: "/repo/a.ts", tags: ["agent", "claude"] },
      { path: "/repo/b.ts", tags: ["claude"] },
    ]);
  });
});

describe("a unified diff", () => {
  test("becomes numbered lines with the hunk headers kept", () => {
    const text = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " tail",
      "",
    ].join("\n");
    const [file] = parseUnified(text);
    expect(file.path).toBe("a.ts");
    expect(file.lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: "keep", old: 1, new: 1 },
      { kind: "remove", text: "old", old: 2 },
      { kind: "add", text: "new", new: 2 },
      { kind: "context", text: "tail", old: 3, new: 3 },
    ]);
  });

  test("nothing to show when the files do not differ", () => {
    expect(parseUnified("")).toEqual([]);
  });
});

describe("a followed session", () => {
  test("keeps the facts its events say and stops following them with the last pane", async () => {
    const { host, agents } = await setUpAgents();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a")!;
    expect(host.client.liveEvents().map((subscription) => subscription.sessionId)).toEqual(["a"]);
    const [events] = host.client.liveEvents();
    events.emit({ type: "plan", entries: [{ content: "one", status: "pending" }] });
    events.emit({ type: "setting_changed", harness: "suite", option: "approvals", value: "review" });
    expect(chat.plans()).toHaveLength(1);
    expect(chat.approvals()).toBe("review");
    expect(chat.running()).toBe(false);
  });

  test("an agent's own chat follows that agent's view and none of the events", async () => {
    const { host, agents } = await setUpAgents();
    await agents.ensureStarted();
    const chat = agents.openAgentChat("a", "claude")!;
    expect(host.client.liveViews().map((view) => [view.sessionId, view.agent])).toEqual([["a", "claude"]]);
    expect(host.client.liveEvents()).toHaveLength(0);
    chat.stop();
    expect(host.client.liveViews()).toHaveLength(0);
  });
});
