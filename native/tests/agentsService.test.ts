import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { leaves } from "../plugins/layout/layoutTree";
import { LayoutService } from "../plugins/layout/service";
import { AGENT_PANE_TYPE, AgentsService, freeAppName, type AgentsTiming } from "../plugins/agents/service";
import { FakeWorkspace, setUpAgents as setUp } from "./support/agentsSetup";
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
const QUICK: AgentsTiming = { connectTimeoutMs: 40, requestTimeoutMs: 20, reconnectTimeoutMs: 40 };

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
