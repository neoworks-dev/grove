import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";
import { AGENT_PANE_TYPE, AgentsService, freeAppName, nextRetryDelay, serviceOpeners, type AgentsTiming, type Openers } from "../plugins/agents/service";
import { FakeWorkspace, setUpAgents as setUp } from "./support/agentsSetup";
import type { SessionEvent } from "@suite/protocol/types";
import { FakeHost, agentItem, sessionInfo } from "./support/fakeSuite";
import { settle } from "./support/fakeSidecar";

describe("connecting", () => {
  test("nothing connects until something needs the daemon", async () => {
    const { host, agents } = await setUp();
    expect(agents.state().connection).toBe("idle");
    expect(host.calls).toEqual([]);
  });

  test("a running daemon is connected to without starting one", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    expect(agents.state().connection).toBe("open");
    expect(host.calls).toEqual(["address", "connect"]);
    expect(host.calls).not.toContain("startDaemon");
  });

  test("a daemon that is not running is started, then connected to", async () => {
    const { host, agents } = await setUp();
    host.running = false;
    await agents.ensureStarted();
    expect(host.calls).toEqual(["address", "startDaemon", "address", "connect"]);
    expect(agents.state().connection).toBe("open");
  });

  test("a daemon that cannot be started leaves the plugin unavailable, saying why", async () => {
    const { host, agents } = await setUp();
    host.running = false;
    host.startFails = "could not run suite";
    await agents.ensureStarted();
    expect(agents.state()).toEqual({ connection: "unavailable", message: "could not run suite" });
    expect(host.calls).not.toContain("connect");
  });

  test("trying again connects once the daemon can be started", async () => {
    const { host, agents } = await setUp();
    host.running = false;
    host.startFails = "no suite";
    await agents.ensureStarted();
    host.startFails = null;
    await agents.retry();
    expect(agents.state().connection).toBe("open");
  });

  test("asking twice connects once", async () => {
    const { host, agents } = await setUp();
    await Promise.all([agents.ensureStarted(), agents.ensureStarted()]);
    await agents.ensureStarted();
    expect(host.calls.filter((call) => call === "connect")).toHaveLength(1);
  });

  test("the window registers as a Grove app in the shown worktree", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    expect(host.client.presences).toEqual([{ app: "grove", kind: "app", title: "Grove", open: true, context: { cwd: "/repo" } }]);
  });

  test("a second window takes the next free name", () => {
    const connectors = [{ app: "grove", connected: true }, { app: "grove-2", connected: true }, { app: "grove-3", connected: false }];
    expect(freeAppName(connectors as never)).toBe("grove-3");
    expect(freeAppName([])).toBe("grove");
  });

  test("the connection state follows the client", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.state.set("reconnecting");
    expect(agents.state().connection).toBe("reconnecting");
    host.client.state.set("open");
    expect(agents.state().connection).toBe("open");
  });

  test("the address is read afresh each time the client reconnects", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.calls.length = 0;
    await host.connectOptions[0].address();
    expect(host.calls).toEqual(["address"]);
  });
});

/** Short waits, so a daemon that never answers is given up on within a test. */
const QUICK: AgentsTiming = { connectTimeoutMs: 40, requestTimeoutMs: 20, reconnectTimeoutMs: 40, retryInitialMs: 10_000, retryMaxMs: 10_000 };
const RETRYING: AgentsTiming = { ...QUICK, retryInitialMs: 30, retryMaxMs: 60 };

/** Waits for real time to pass, for the timeouts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("a daemon that is alive but wedged", () => {
  test("a connection that is never answered ends as unavailable, not as a wait without end", async () => {
    const { host, agents } = await setUp(QUICK);
    host.holdConnect();
    await agents.ensureStarted();
    expect(agents.state().connection).toBe("unavailable");
    expect(agents.state().message).toBe("The suite daemon did not answer");
  });

  test("a daemon that connects but never lists its sessions ends as unavailable and the client is closed", async () => {
    const { host, agents } = await setUp(QUICK);
    host.client.listingHangs = true;
    await agents.ensureStarted();
    expect(agents.state().connection).toBe("unavailable");
    expect(host.client.closed).toBe(true);
  });

  test("a client that answers after the service gave up is closed, not adopted", async () => {
    const { host, agents } = await setUp(QUICK);
    host.holdConnect();
    await agents.ensureStarted();
    host.releaseConnect();
    await sleep(10);
    expect(host.client.closed).toBe(true);
    expect(agents.state().connection).toBe("unavailable");
  });

  test("trying again connects once the daemon answers", async () => {
    const { host, agents } = await setUp(QUICK);
    host.holdConnect();
    await agents.ensureStarted();
    host.releaseConnect();
    await sleep(10);
    host.client.closed = false;
    await agents.retry();
    expect(agents.state().connection).toBe("open");
    expect(host.client.closed).toBe(false);
  });

  test("the client is asked to give up on a request, and not to wait for the daemon without end", async () => {
    const { host, agents } = await setUp(QUICK);
    await agents.ensureStarted();
    expect(host.connectOptions[0].requestTimeoutMs).toBe(20);
  });

  test("a connection that stays down is given up on, and one that comes back in time is kept", async () => {
    const { host, agents } = await setUp(QUICK);
    await agents.ensureStarted();
    host.client.state.set("reconnecting");
    await sleep(10);
    host.client.state.set("open");
    await sleep(60);
    expect(agents.state().connection).toBe("open");
    host.client.state.set("reconnecting");
    await sleep(60);
    expect(agents.state().connection).toBe("unavailable");
    expect(agents.state().message).toBe("The suite daemon stopped answering");
    expect(host.client.closed).toBe(true);
  });
});

describe("showing a change", () => {
  /** Openers that record what they were asked, and whether a diff view is there to answer. */
  function recordingOpeners(hasDiff: boolean): { openers: Openers; asked: string[] } {
    const asked: string[] = [];
    const openers: Openers = {
      openFile: (path) => asked.push(`file ${path}`),
      revealFile: async (path, line) => {
        asked.push(`reveal ${path}:${line}`);
      },
      openDiff: (path, texts) => {
        if (!hasDiff) {
          return false;
        }
        asked.push(texts === undefined ? `diff ${path}` : `diff ${path} ${texts.oldText}>${texts.newText}`);
        return true;
      },
    };
    return { openers, asked };
  }

  test("goes to the diff view, with the two texts when a call reported them", async () => {
    const { openers, asked } = recordingOpeners(true);
    const { agents } = await setUp(undefined, openers);
    agents.openDiff("/repo/a.ts");
    agents.openDiff("/repo/a.ts", { oldText: "one", newText: "two" });
    expect(asked).toEqual(["diff /repo/a.ts", "diff /repo/a.ts one>two"]);
  });

  test("shows the file when the app has no diff view", async () => {
    const { openers, asked } = recordingOpeners(false);
    const { agents } = await setUp(undefined, openers);
    agents.openDiff("/repo/a.ts");
    expect(asked).toEqual(["file /repo/a.ts"]);
  });

  test("a chat asks for the one change its calls add up to, else the file against HEAD", async () => {
    const { openers, asked } = recordingOpeners(true);
    const { host, agents } = await setUp(undefined, openers);
    await agents.ensureStarted();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a");
    const emit = (event: SessionEvent): void => host.client.events[0].emit(event);
    emit({ type: "tool_call", toolCallId: "1", title: "Edit", kind: "edit", status: "pending" });
    emit({ type: "tool_call_update", toolCallId: "1", content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }] });
    emit({ type: "tool_call", toolCallId: "2", title: "Edit", kind: "edit", status: "pending" });
    emit({ type: "tool_call_update", toolCallId: "2", content: [{ type: "diff", path: "/repo/a.ts", oldText: "b", newText: "c" }] });
    chat?.openDiff("/repo/a.ts");
    emit({ type: "tool_call", toolCallId: "3", title: "Edit", kind: "edit", status: "pending" });
    emit({ type: "tool_call_update", toolCallId: "3", content: [{ type: "diff", path: "/repo/a.ts", oldText: "zzz", newText: "d" }] });
    chat?.openDiff("/repo/a.ts");
    expect(asked).toEqual(["diff /repo/a.ts a>c", "diff /repo/a.ts"]);
  });
});

describe("retrying by itself", () => {
  test("a connection that was lost is tried again, and the daemon being back ends the waiting", async () => {
    const { host, agents } = await setUp(RETRYING);
    await agents.ensureStarted();
    host.client.state.set("reconnecting");
    await sleep(60);
    expect(agents.state().connection).toBe("unavailable");
    expect(agents.state().retryAt).toBeGreaterThan(Date.now() - 100);
    host.client.state.set("open");
    await sleep(60);
    expect(host.calls.filter((call) => call === "connect")).toHaveLength(2);
    expect(agents.state()).toEqual({ connection: "open" });
  });

  test("a daemon that never came up is not tried again until the user asks", async () => {
    const { host, agents } = await setUp(RETRYING);
    host.running = false;
    host.startFails = "no suite";
    await agents.ensureStarted();
    await sleep(100);
    expect(host.calls.filter((call) => call === "startDaemon")).toHaveLength(1);
    expect(agents.state().retryAt).toBeUndefined();
  });

  test("pressing Try again connects at once and drops the wait", async () => {
    const { host, agents } = await setUp(RETRYING);
    await agents.ensureStarted();
    host.client.state.set("reconnecting");
    await sleep(60);
    expect(agents.state().connection).toBe("unavailable");
    host.client.state.set("open");
    await agents.retry();
    expect(agents.state()).toEqual({ connection: "open" });
    await sleep(80);
    expect(host.calls.filter((call) => call === "connect")).toHaveLength(2);
  });

  test("the wait doubles after each attempt that fails, up to the longest", () => {
    const delays: number[] = [];
    let delay = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      delay = nextRetryDelay(delay, 2000, 10_000);
      delays.push(delay);
    }
    expect(delays).toEqual([2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });
});

describe("the session list", () => {
  test("follows the daemon's announcements and groups them by the shown worktree", async () => {
    const { host, agents, workspace } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([
      sessionInfo({ id: "a", cwd: "/repo", lastActivity: 5 }),
      sessionInfo({ id: "b", cwd: "/repo/.worktrees/feature", lastActivity: 9 }),
      sessionInfo({ id: "c", cwd: "/elsewhere", lastActivity: 20 }),
    ]);
    expect(agents.sessions()).toHaveLength(3);
    expect(agents.groups().map((group) => [group.name, group.rows.map((row) => row.info.id)])).toEqual([
      ["main", ["a"]],
      ["feature", ["b"]],
    ]);
    workspace.selectedId = "feature";
    expect(agents.groups().map((group) => group.name)).toEqual(["feature", "main"]);
  });

  test("a running session says so", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([sessionInfo({ id: "a", state: "running" }), sessionInfo({ id: "b" })]);
    expect(agents.isRunning("a")).toBe(true);
    expect(agents.isRunning("b")).toBe(false);
    expect(agents.isRunning("unknown")).toBe(false);
  });
});

describe("panes", () => {
  test("the first session opens in a pane split off the focused one", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    const panes = leaves(layout.root);
    expect(panes.map((pane) => pane.paneTypeId)).toEqual(["editor", AGENT_PANE_TYPE]);
    expect(agents.sessionOfPane(panes[1].id)).toBe("a");
    expect(layout.focusedLeafId).toBe(panes[1].id);
  });

  test("another session takes over the agent pane that is focused", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    agents.openSession("b");
    const panes = leaves(layout.root);
    expect(panes).toHaveLength(2);
    expect(agents.sessionOfPane(panes[1].id)).toBe("b");
  });

  test("an agent pane that is not focused is reused and focused", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    const [editorPane, agentPane] = leaves(layout.root);
    layout.focus(editorPane.id);
    agents.openSession("b");
    expect(leaves(layout.root)).toHaveLength(2);
    expect(agents.sessionOfPane(agentPane.id)).toBe("b");
    expect(layout.focusedLeafId).toBe(agentPane.id);
  });

  test("a session that a pane already shows is focused, not opened again", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    const [editorPane, agentPane] = leaves(layout.root);
    layout.focus(editorPane.id);
    agents.openSession("a");
    expect(leaves(layout.root)).toHaveLength(2);
    expect(layout.focusedLeafId).toBe(agentPane.id);
  });

  test("a split of an agent pane shows the same session", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    layout.splitFocused("column");
    const panes = leaves(layout.root);
    expect(panes.map((pane) => pane.paneTypeId)).toEqual(["editor", AGENT_PANE_TYPE, AGENT_PANE_TYPE]);
    expect(agents.sessionOfPane(panes[2].id)).toBe("a");
  });

  test("a pane's title is its session's title", async () => {
    const { host, layout, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([sessionInfo({ id: "a", title: "Fix the build" })]);
    agents.openSession("a");
    const agentPane = leaves(layout.root)[1];
    expect(agents.paneTitle(agentPane.id)).toBe("Fix the build");
    layout.setPaneState(agentPane.id, { sessionId: "gone" });
    expect(agents.paneTitle(agentPane.id)).toBe("Agent");
  });

  test("a session is shown while a pane has it", async () => {
    const { layout, agents } = await setUp();
    expect(agents.isShown("a")).toBe(false);
    agents.openSession("a");
    expect(agents.isShown("a")).toBe(true);
    layout.closeLeaf(leaves(layout.root)[1].id);
    expect(agents.isShown("a")).toBe(false);
  });
});

describe("the tabs and keys of a pane", () => {
  test("the next and previous session step through the worktree's sessions, around the ends", async () => {
    const { host, layout, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([
      sessionInfo({ id: "a", cwd: "/repo", lastActivity: 3 }),
      sessionInfo({ id: "b", cwd: "/repo", lastActivity: 2 }),
      sessionInfo({ id: "c", cwd: "/repo", lastActivity: 1 }),
      sessionInfo({ id: "other", cwd: "/repo/.worktrees/feature", lastActivity: 9 }),
    ]);
    agents.openSession("b");
    const agentPane = leaves(layout.root)[1];
    agents.stepSession(1);
    expect(agents.sessionOfPane(agentPane.id)).toBe("c");
    agents.stepSession(1);
    expect(agents.sessionOfPane(agentPane.id)).toBe("a");
    agents.stepSession(-1);
    expect(agents.sessionOfPane(agentPane.id)).toBe("c");
  });

  test("a session alone in its worktree has nowhere to step to", async () => {
    const { host, layout, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([sessionInfo({ id: "a", cwd: "/repo" })]);
    agents.openSession("a");
    agents.stepSession(1);
    expect(agents.sessionOfPane(leaves(layout.root)[1].id)).toBe("a");
  });

  test("a pane's view takes keys for the focused pane until it lets go", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    const [editorPane, agentPane] = leaves(layout.root);
    let toggled = 0;
    const release = agents.registerPane(agentPane.id, { togglePanel: () => (toggled += 1), focusAgents: () => true });
    agents.focusedPane()?.togglePanel();
    expect(toggled).toBe(1);
    layout.focus(editorPane.id);
    expect(agents.focusedPane()).toBeUndefined();
    layout.focus(agentPane.id);
    release();
    expect(agents.focusedPane()).toBeUndefined();
  });
});

describe("the focused agent pane", () => {
  test("is none while another kind of pane has the focus, and the pane showing the session when it has", async () => {
    const { layout, agents } = await setUp();
    expect(agents.focusedAgentPane()).toBeNull();
    expect(agents.focusedChat()).toBeUndefined();
    agents.openSession("a");
    const [editorPane, agentPane] = leaves(layout.root);
    expect(agents.focusedAgentPane()).toBe(agentPane.id);
    layout.focus(editorPane.id);
    expect(agents.focusedAgentPane()).toBeNull();
  });

  test("has the conversation its session follows", async () => {
    const { layout, agents } = await setUp();
    agents.openSession("a");
    expect(agents.focusedChat()).toBeUndefined();
    agents.follow("a");
    await settle();
    expect(agents.focusedChat()).toBe(agents.chat("a"));
    expect(leaves(layout.root)).toHaveLength(2);
  });
});

describe("telling the daemon what the window shows", () => {
  test("a session an agent pane shows moves the agent to this window, once", async () => {
    const { host, agents } = await setUp();
    await agents.showing("a");
    expect(host.client.moves).toEqual([{ app: "grove", session: "a" }]);
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    await agents.showing("a");
    expect(host.client.moves).toHaveLength(1);
    await agents.showing("b");
    expect(host.client.moves).toEqual([
      { app: "grove", session: "a" },
      { app: "grove", session: "b" },
    ]);
  });

  test("moves it back when another window or the CLI took it away", async () => {
    const { host, agents } = await setUp();
    await agents.showing("a");
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    host.client.focus.set({ session: "a", app: "cli", reason: "user" });
    await agents.showing("a");
    expect(host.client.moves).toHaveLength(2);
  });

  test("a refused move is kept as the message, and the next one is tried", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.failNext = new Error("unknown app");
    await agents.showing("a");
    expect(agents.state().message).toBe("unknown app");
    await agents.showing("a");
    expect(host.client.moves).toEqual([{ app: "grove", session: "a" }]);
  });

  test("a second window moves the agent under its own name", async () => {
    const { host, agents } = await setUp();
    host.client.connectors = [{ app: "grove", connected: true }] as never;
    await agents.showing("a");
    expect(host.client.moves).toEqual([{ app: "grove-2", session: "a" }]);
  });

  test("another worktree is told as the window's directory", async () => {
    const { host, agents, workspace } = await setUp();
    await agents.ensureStarted();
    workspace.select("feature");
    await settle();
    expect(host.client.contexts).toEqual([{ cwd: "/repo/.worktrees/feature" }]);
    workspace.select("main");
    await settle();
    expect(host.client.contexts).toEqual([{ cwd: "/repo/.worktrees/feature" }, { cwd: "/repo" }]);
  });

  test("a worktree selected before the daemon is connected is told with the presence", async () => {
    const { host, agents, workspace } = await setUp();
    workspace.select("feature");
    await settle();
    expect(host.client.contexts).toEqual([]);
    await agents.ensureStarted();
    expect(host.client.presences[0].context).toEqual({ cwd: "/repo/.worktrees/feature" });
  });

  test("the agent moving to a session no pane shows, after /clear, puts it in the pane that showed the last", async () => {
    const { host, layout, agents } = await setUp();
    agents.openSession("a");
    const agentPane = leaves(layout.root)[1].id;
    await agents.showing("a");
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    host.client.focus.set({ session: "a2", app: "grove", reason: "session" });
    expect(agents.sessionOfPane(agentPane)).toBe("a2");
    await agents.showing("a2");
    expect(host.client.moves).toHaveLength(1);
  });

  test("moves the daemon makes on its own, for another app, or before the one asked for are not followed", async () => {
    const { host, layout, agents } = await setUp();
    agents.openSession("a");
    const agentPane = leaves(layout.root)[1].id;
    host.client.focus.set({ session: "b", app: "grove", reason: "opened" });
    await agents.showing("a");
    host.client.focus.set({ session: "old", app: "grove", reason: "session" });
    expect(agents.sessionOfPane(agentPane)).toBe("a");
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    host.client.focus.set({ session: "c", app: "grove-2", reason: "user" });
    host.client.focus.set({ session: "d", app: undefined, reason: "closed" });
    expect(agents.sessionOfPane(agentPane)).toBe("a");
  });

  test("a session another pane shows is left alone", async () => {
    const { host, layout, agents } = await setUp();
    agents.openSession("a");
    layout.splitFocused("column");
    const panes = leaves(layout.root);
    layout.setPaneState(panes[2].id, { sessionId: "b" });
    await agents.showing("b");
    host.client.focus.set({ session: "b", app: "grove", reason: "user" });
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    expect(agents.sessionOfPane(panes[1].id)).toBe("a");
    expect(agents.sessionOfPane(panes[2].id)).toBe("b");
  });

  test("without a pane to put it in, the agent's move is only noted", async () => {
    const { host, layout, agents } = await setUp();
    await agents.showing("a");
    host.client.focus.set({ session: "a", app: "grove", reason: "user" });
    host.client.focus.set({ session: "z", app: "grove", reason: "session" });
    expect(leaves(layout.root)).toHaveLength(1);
  });
});

describe("new sessions", () => {
  test("start in the shown worktree and open in a pane", async () => {
    const { host, layout, agents, workspace } = await setUp();
    workspace.selectedId = "feature";
    const id = await agents.newSession();
    expect(host.client.created).toEqual([{ cwd: "/repo/.worktrees/feature" }]);
    expect(id).toBe("s_new1");
    expect(agents.sessionOfPane(leaves(layout.root)[1].id)).toBe("s_new1");
  });

  test("start the daemon first when it is not running", async () => {
    const { host, agents } = await setUp();
    host.running = false;
    await agents.newSession();
    expect(host.calls).toContain("startDaemon");
    expect(host.client.created).toHaveLength(1);
  });

  test("do nothing when the daemon cannot be reached", async () => {
    const { host, layout, agents } = await setUp();
    host.running = false;
    host.startFails = "no suite";
    expect(await agents.newSession()).toBeNull();
    expect(leaves(layout.root)).toHaveLength(1);
  });
});

describe("following a session", () => {
  test("starts one view for any number of panes and stops with the last", async () => {
    const { host, agents } = await setUp();
    const releaseFirst = agents.follow("a");
    const releaseSecond = agents.follow("a");
    await settle();
    expect(host.client.liveViews().map((view) => view.sessionId)).toEqual(["a"]);
    releaseFirst();
    expect(host.client.liveViews()).toHaveLength(1);
    releaseSecond();
    expect(host.client.liveViews()).toHaveLength(0);
    expect(agents.chat("a")).toBeUndefined();
  });

  test("letting go twice counts once", async () => {
    const { host, agents } = await setUp();
    const releaseFirst = agents.follow("a");
    agents.follow("a");
    await settle();
    releaseFirst();
    releaseFirst();
    expect(host.client.liveViews()).toHaveLength(1);
  });

  test("a pane that asks before the daemon is up gets its chat once it is", async () => {
    const { host, agents } = await setUp();
    host.running = false;
    host.startFails = "no suite";
    agents.follow("a");
    await settle();
    expect(agents.state().connection).toBe("unavailable");
    expect(agents.chat("a")).toBeUndefined();
    host.startFails = null;
    await agents.retry();
    expect(agents.chat("a")).toBeDefined();
    expect(host.client.liveViews().map((view) => view.sessionId)).toEqual(["a"]);
  });

  test("the chat shows what the daemon's view says, streaming included", async () => {
    const { host, agents } = await setUp();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a")!;
    const [view] = host.client.liveViews();
    view.snapshot({ session: "a", seq: 1, items: [agentItem("m1", "Hel")] });
    expect(chat.items()).toHaveLength(1);
    view.patch({
      session: "a",
      seq: 2,
      ops: [{ op: "blocks", ref: "m1", path: [], from: 0, blocks: [{ type: "paragraph", spans: [{ text: "Hello" }] }] }],
    });
    const component = chat.items()[0].component;
    expect(component.type === "text" && component.blocks[0]).toEqual({ type: "paragraph", spans: [{ text: "Hello" }] });
  });

  test("sending, cancelling and pressing a button reach the session", async () => {
    const { host, agents } = await setUp();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a")!;
    await chat.send("hello");
    await chat.cancel();
    await chat.action("ref1", "allow", { note: "yes" });
    expect(host.client.inputs).toEqual([{ session: "a", text: "hello" }]);
    expect(host.client.cancels).toEqual(["a"]);
    expect(host.client.actions).toEqual([{ session: "a", ref: "ref1", action: "allow", args: { note: "yes" } }]);
  });

  test("a refused call is kept as the chat's error until the next call works", async () => {
    const { host, agents } = await setUp();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a")!;
    host.client.failNext = new Error("unknown session");
    await chat.send("hello");
    expect(chat.error()).toBe("unknown session");
    await chat.send("again");
    expect(chat.error()).toBeNull();
  });

  test("a picture the daemon holds is loaded from the daemon's URL", async () => {
    const { agents } = await setUp();
    agents.follow("a");
    await settle();
    const chat = agents.chat("a")!;
    expect(chat.assetSource("asset://img-0123456789ab")).toBe("http://127.0.0.1:4000/assets/img-0123456789ab?token=token");
    expect(chat.assetSource("/tmp/picture.png")).toBe("/tmp/picture.png");
  });
});

describe("unloading", () => {
  test("closes the connection and stops every view", async () => {
    const root = new RootContext();
    const host = new FakeHost();
    let agents!: AgentsService;
    const plugin = await root.plugin({
      name: "agents-test",
      apply: (ctx: Context) => {
        const layout = new LayoutService(ctx, "editor", null);
        agents = new AgentsService(ctx, host, layout, new FakeWorkspace());
      },
    });
    agents.follow("a");
    await settle();
    expect(host.client.liveViews()).toHaveLength(1);
    await plugin.dispose();
    expect(host.client.closed).toBe(true);
    expect(host.client.liveViews()).toHaveLength(0);
  });
});

describe("the openers over the editor and diff services", () => {
  test("a change opens over the file in an editor, against HEAD or against where the agent started", () => {
    const asked: string[] = [];
    const openers = serviceOpeners(
      { open: (path) => asked.push(`file ${path}`), reveal: async () => {} },
      {
        async showInEditor(path, base) {
          asked.push(base === undefined ? `diff ${path}` : `diff ${path} ${base.label}: ${base.text}`);
          return true;
        },
      },
    );
    expect(openers.openDiff("/repo/a.ts")).toBe(true);
    expect(openers.openDiff("/repo/a.ts", { oldText: "one", newText: "two" })).toBe(true);
    expect(asked).toEqual(["diff /repo/a.ts", "diff /repo/a.ts the agent's start: one"]);
  });
});

describe("sending a review", () => {
  test("goes to the session whose agent touched the files, even when another is focused or newer", async () => {
    const { host, agents, layout } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([
      sessionInfo({ id: "old", cwd: "/repo", lastActivity: 1 }),
      sessionInfo({ id: "new", cwd: "/repo", lastActivity: 9 }),
    ]);
    agents.follow("old");
    await settle();
    host.client.events[0].emit({
      type: "tool_call_update",
      toolCallId: "t",
      content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
    });
    agents.openSession("new");
    expect(layout.focusedLeafId).not.toBe("");
    expect(agents.reviewSessionFor("/repo", ["/repo/src/a.ts"])).toBe("old");
  });

  test("falls back to the session in the focused agent pane", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([
      sessionInfo({ id: "a", cwd: "/repo", lastActivity: 9 }),
      sessionInfo({ id: "b", cwd: "/repo", lastActivity: 1 }),
    ]);
    agents.openSession("b");
    await settle();
    expect(agents.reviewSessionFor("/repo", ["/repo/src/a.ts"])).toBe("b");
  });

  test("then to the session of the worktree that was active last, and never one of another worktree", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([
      sessionInfo({ id: "a", cwd: "/repo", lastActivity: 3 }),
      sessionInfo({ id: "b", cwd: "/repo/src", lastActivity: 7 }),
      sessionInfo({ id: "c", cwd: "/repo/.worktrees/feature", lastActivity: 99 }),
      sessionInfo({ id: "d", cwd: "/repository", lastActivity: 99 }),
    ]);
    expect(agents.reviewSessionFor("/repo", ["/repo/x.ts"])).toBe("b");
    expect(agents.reviewSessionFor("/repo/.worktrees/feature", [])).toBe("c");
    expect(agents.reviewSessionFor("/elsewhere", [])).toBeNull();
  });

  test("sends the text to the agent with the line the chat shows in its place", async () => {
    const { host, agents } = await setUp();
    await agents.ensureStarted();
    host.client.sessions.set([sessionInfo({ id: "a", cwd: "/repo" })]);
    await agents.sendReview("a", "the whole review", "Review: 2 comments on 1 file");
    expect(host.client.inputs).toEqual([{ session: "a", text: "the whole review", shown: "Review: 2 comments on 1 file" }]);
    agents.follow("a");
    await settle();
    await agents.sendReview("a", "again", "Review: 1 comment on 1 file");
    expect(host.client.inputs[1]).toEqual({ session: "a", text: "again", shown: "Review: 1 comment on 1 file" });
  });

  test("says so when the daemon is not connected", async () => {
    const { agents } = await setUp();
    await expect(agents.sendReview("a", "text", "shown")).rejects.toThrow("not connected");
  });
});
