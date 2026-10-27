import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import { checkComponents, Program, type UiNode } from "@neoworks/neoui";
import { EditorService, type DocumentEvent, type DocumentHost, type DocumentSummary } from "../plugins/editor/service";
import { OPEN_ISSUE_TOOL, groveComponents } from "../plugins/agents/groveComponents";
import { groveTools } from "../plugins/agents/groveTools";
import { GithubClient, type GhRunner } from "../plugins/github/client";
import { GITHUB_PANE_TYPE, GithubService } from "../plugins/github/service";
import { LayoutService } from "../plugins/layout/service";
import { AgentsService, serviceOpeners } from "../plugins/agents/service";
import { FakeHost } from "./support/fakeSuite";
import { noEditDiffs } from "./support/fakeEditDiffs";
import { FakeWorkspace, setUpAgents, type AgentsSetup } from "./support/agentsSetup";

/** The agents service with Grove's own components and tools registered, as the plugin does. */
async function setUpWithCards(): Promise<AgentsSetup> {
  const setup = await setUpAgents();
  setup.agents.registerTools(groveTools(setup.agents));
  setup.agents.registerComponents(groveComponents);
  return setup;
}

/** Draws a component's body with these params, as the daemon does for a use of it. */
function draw(name: string, args: Record<string, unknown>): { root: UiNode | undefined; errors: unknown } {
  const component = groveComponents[name];
  const program = new Program("test", { markdown: (text: string) => [{ type: "paragraph", text }] as never });
  program.useBody(component.neoui, args, Object.keys(component.params), false);
  const doc = program.doc();
  program.dispose();
  return { root: doc.root, errors: doc.errors };
}

/** Every node of a tree, depth first. */
function nodesOf(node: UiNode): UiNode[] {
  const found = [node];
  for (const value of Object.values(node.props)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (typeof child === "object" && child !== null && "component" in child) {
        found.push(...nodesOf(child as UiNode));
      }
    }
  }
  return found;
}

/** The labels of the tags a drawn card shows. */
function tagLabels(root: UiNode | undefined): unknown[] {
  return nodesOf(root as UiNode)
    .filter((node) => node.component === "Tag")
    .map((node) => node.props["label"]);
}

describe("the components Grove registers", () => {
  test("the presence of the first window carries the three components and an endpoint for their tools", async () => {
    const { host, agents } = await setUpWithCards();
    await agents.ensureStarted();
    const presence = host.client.presences[0];
    expect(presence.app).toBe("grove");
    expect(Object.keys(presence.components ?? {}).sort()).toEqual(["ExplainCard", "IssueCard", "PrCard"]);
    expect(presence.mcp).toEqual({ url: "http://127.0.0.1:1/mcp?v=1", headers: { Authorization: "Bearer token" } });
    expect(host.tools.served[0].map((tool) => tool.name)).toEqual(["openFile", "openIssue"]);
  });

  test("every body passes the daemon's own registration check", () => {
    const { usable, problems } = checkComponents(groveComponents);
    expect(problems).toEqual([]);
    expect(Object.keys(usable).sort()).toEqual(["ExplainCard", "IssueCard", "PrCard"]);
  });

  test("params are typed, with the optional ones last", () => {
    expect(groveComponents["IssueCard"].params).toEqual({
      repo: "string",
      number: "number",
      title: "string",
      state: "string",
      author: "string?",
      labels: "string[]?",
      body: "string?",
      comments: "number?",
      url: "string?",
    });
    expect(groveComponents["PrCard"].params["changedFiles"]).toBe("number?");
    expect(groveComponents["ExplainCard"].params["points"]).toBe("string[]?");
  });

  test("a second window offers neither components nor tools, since the names belong to the app id", async () => {
    const { host, agents } = await setUpWithCards();
    host.client.connectors.value = [{ app: "grove", kind: "app", connected: true, v: 1, tools: [] }];
    await agents.ensureStarted();
    const presence = host.client.presences[0];
    expect(presence.app).toBe("grove-2");
    expect(presence.components).toBeUndefined();
    expect(presence.mcp).toBeUndefined();
    expect(host.tools.served).toEqual([]);
  });

  test("a component added after the window is connected is sent, and taking it away sends the rest", async () => {
    const { host, agents } = await setUpAgents();
    await agents.ensureStarted();
    expect(host.client.presences[0].components).toBeUndefined();
    const remove = agents.registerComponents({ Note: { description: "A note", params: { text: "string" }, neoui: "<Text text={text}/>" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(Object.keys(host.client.presences[1].components ?? {})).toEqual(["Note"]);
    remove();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.client.presences[2].components).toBeUndefined();
  });

  test("a name that is taken is refused", async () => {
    const { agents } = await setUpWithCards();
    expect(() => agents.registerComponents({ IssueCard: groveComponents["IssueCard"] })).toThrow("already registered");
  });

  test("a host that cannot serve tools still registers the window with its components", async () => {
    const { host, agents } = await setUpWithCards();
    host.tools.failNext = new Error("no tool server");
    await agents.ensureStarted();
    const presence = host.client.presences[0];
    expect(presence.mcp).toBeUndefined();
    expect(Object.keys(presence.components ?? {})).toHaveLength(3);
    expect(agents.state().message).toBe("no tool server");
  });
});

describe("drawing the cards", () => {
  const issue = {
    repo: "neoworks-dev/grove",
    number: 12,
    title: "Tab strip overflow",
    state: "open",
    author: "moritz",
    labels: ["bug", "area:panes"],
    body: "The strip clips.",
    comments: 3,
    url: "https://github.com/neoworks-dev/grove/issues/12",
  };

  test("an issue shows its state and labels as tags and links to GitHub", () => {
    const { root, errors } = draw("IssueCard", issue);
    expect(errors).toBeUndefined();
    expect(tagLabels(root)).toEqual(["Open", "bug", "area:panes"]);
    const buttons = nodesOf(root as UiNode).filter((node) => node.component === "Button");
    expect(buttons.map((node) => node.props["label"])).toEqual(["Open in Grove", "Open on GitHub"]);
    expect(buttons.map((node) => node.props["url"])).toEqual([undefined, issue.url]);
    const header = nodesOf(root as UiNode).find((node) => node.component === "Header");
    expect(header?.props).toEqual({ title: "Tab strip overflow", subtitle: "neoworks-dev/grove #12" });
  });

  test("a closed issue says so, and one with only the required params draws no empty parts", () => {
    expect(tagLabels(draw("IssueCard", { ...issue, state: "closed" }).root)).toEqual(["Closed", "bug", "area:panes"]);
    const { root, errors } = draw("IssueCard", { repo: "a/b", number: 1, title: "T", state: "open" });
    expect(errors).toBeUndefined();
    const components = nodesOf(root as UiNode).map((node) => node.component);
    expect(components).not.toContain("KeyValue");
    // Without an address there is nothing to open on GitHub, but the item can still be opened in Grove.
    const labels = nodesOf(root as UiNode).filter((node) => node.component === "Button").map((node) => node.props["label"]);
    expect(labels).toEqual(["Open in Grove"]);
  });

  test("a pull request shows each state, its branches and its size", () => {
    const pull = {
      repo: "neoworks-dev/grove",
      number: 7,
      title: "Add cards",
      state: "draft",
      head: "513-cards",
      base: "main",
      additions: 120,
      deletions: 4,
      changedFiles: 6,
      checks: "failing",
      review: "approved",
      url: "https://github.com/neoworks-dev/grove/pull/7",
    };
    for (const [state, label] of [["open", "Open"], ["draft", "Draft"], ["merged", "Merged"], ["closed", "Closed"]]) {
      expect(tagLabels(draw("PrCard", { ...pull, state }).root)).toEqual([label]);
    }
    const { root, errors } = draw("PrCard", pull);
    expect(errors).toBeUndefined();
    const pairs = nodesOf(root as UiNode).filter((node) => node.component === "KV");
    expect(pairs.map((node) => [node.props["key"], node.props["value"]])).toEqual([
      ["Added", "+120"],
      ["Removed", "-4"],
      ["Files changed", 6],
      ["Checks", "Failing"],
      ["Review", "Approved"],
    ]);
    const text = nodesOf(root as UiNode).find((node) => node.component === "Text");
    expect(text?.props["text"]).toBe("`513-cards` into `main`");
    const labels = nodesOf(root as UiNode).filter((node) => node.component === "Button").map((node) => node.props["label"]);
    expect(labels).toEqual(["Open in Grove", "Open on GitHub"]);
  });

  test("pressing Open in Grove calls the open-issue tool with the card's repository, number and kind", async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    for (const [name, kind] of [["IssueCard", "issue"], ["PrCard", "pull"]]) {
      const component = groveComponents[name];
      const program = new Program("test", {
        markdown: (text: string) => [{ type: "paragraph", text }] as never,
        callTool: async (tool: string, args: Record<string, unknown>) => {
          calls.push({ tool, args });
          return null;
        },
      });
      const params = { repo: "neoworks-dev/grove", number: 514, title: "T", state: "open", head: "h", base: "main" };
      program.useBody(component.neoui, params, Object.keys(component.params), false);
      const button = nodesOf(program.doc().root as UiNode).find((node) => node.props["label"] === "Open in Grove");
      await program.press(button?.key as string);
      program.dispose();
      expect(calls[calls.length - 1]).toEqual({ tool: OPEN_ISSUE_TOOL, args: { repo: "neoworks-dev/grove", number: 514, kind } });
    }
  });

  test("an explanation of code shows the snippet and a button that calls the open-file tool", () => {
    const { root, errors } = draw("ExplainCard", {
      title: "How the cursor moves",
      explanation: "It **walks** the rope.",
      points: ["Counts bytes", "Not columns"],
      code: "fn step() {}",
      path: "src/cursor.rs",
      startLine: 40,
      language: "rust",
    });
    expect(errors).toBeUndefined();
    const nodes = nodesOf(root as UiNode);
    expect(nodes.find((node) => node.component === "Code")?.props).toEqual({ code: "fn step() {}", language: "rust" });
    expect(nodes.find((node) => node.component === "List")?.props["items"]).toEqual(["Counts bytes", "Not columns"]);
    expect(nodes.some((node) => node.props["text"] === "src/cursor.rs:40")).toBe(true);
    const button = nodes.find((node) => node.component === "Button");
    expect(button?.props["label"]).toBe("Open in editor");
  });

  test("an explanation of a concept has no code and no button", () => {
    const { root, errors } = draw("ExplainCard", { title: "Backpressure", explanation: "A slow reader slows the writer." });
    expect(errors).toBeUndefined();
    const components = nodesOf(root as UiNode).map((node) => node.component);
    expect(components).toEqual(["Card", "Header", "Text"]);
  });
});

/** A host with one document per path, which is all opening needs. */
class PathHost implements DocumentHost {
  documents = new Map<string, DocumentSummary>();

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
  async setDecorations(): Promise<void> {}
  async openText(): Promise<DocumentSummary> {
    throw new Error("not used");
  }
  async text(): Promise<string> {
    return "";
  }
  async setText(): Promise<void> {}
  async reload(): Promise<void> {}

  async sync(): Promise<boolean> {
    return false;
  }

  onEvent(_handler: (event: DocumentEvent) => void): () => void {
    return () => {};
  }
}

describe("the open-file tool", () => {
  /** The agents service over the real editor service, so a call goes all the way to the cursor. */
  async function setUpWithEditor(): Promise<{ host: FakeHost; editor: EditorService; agents: AgentsService }> {
    const root = new RootContext();
    const host = new FakeHost();
    let editor!: EditorService;
    let agents!: AgentsService;
    await root.plugin({
      name: "tool-test",
      apply: (ctx: Context) => {
        const layout = new LayoutService(ctx, "editor", null);
        editor = new EditorService(ctx, new PathHost(), layout);
        const diff = { ...noEditDiffs, showInEditor: async () => true };
        agents = new AgentsService(ctx, host, layout, new FakeWorkspace(), undefined, serviceOpeners(editor, diff, { openItem: async () => null }));
      },
    });
    agents.registerTools(groveTools(agents));
    await agents.ensureStarted();
    return { host, editor, agents };
  }

  test("a call from a button shows the file in the editor with the cursor on the line", async () => {
    const { host, editor } = await setUpWithEditor();
    const result = await host.tools.call("openFile", { path: "/repo/src/cursor.rs", line: 40 });
    expect(result).toBe("Opened /repo/src/cursor.rs at line 40");
    expect(editor.active()?.path).toBe("/repo/src/cursor.rs");
    expect(editor.pendingReveal()).toEqual({ documentId: 1, line: 39, character: 0 });
  });

  test("a relative path is taken from the shown worktree, and a missing line is the first", async () => {
    const { host, editor } = await setUpWithEditor();
    await host.tools.call("openFile", { path: "src/a.rs", line: null });
    expect(editor.active()?.path).toBe("/repo/src/a.rs");
    expect(editor.pendingReveal()).toEqual({ documentId: 1, line: 0, character: 0 });
  });

  test("a call without a path fails with a message the agent can read", async () => {
    const { host } = await setUpWithEditor();
    await expect(host.tools.call("openFile", {})).rejects.toThrow("openFile needs a path");
  });
});

/** A `gh` that answers an issue's page and nothing else, for the tool to read through. */
const issueGh: GhRunner = async ({ args }) => {
  if (args[0] === "auth") {
    return { stdout: "", error: null };
  }
  if (args[1] === "repos/other/thing/issues/9") {
    const page = { number: 9, title: "Crash on save", state: "open", body: "It crashes.", user: "ada", assignees: [], labels: [], comments: 0, pull: false };
    return { stdout: JSON.stringify(page), error: null };
  }
  if (args[1] === "repos/other/thing/issues/9/comments?per_page=100") {
    return { stdout: "", error: null };
  }
  return { stdout: "", error: { kind: "failed", message: `nothing answers ${args.join(" ")}`, code: 1 } };
};

describe("the open-issue tool", () => {
  /** The agents service over the real GitHub service and layout, so a call goes all the way to the pane. */
  async function setUpWithGithub(): Promise<{ host: FakeHost; layout: LayoutService; github: GithubService; agents: AgentsService }> {
    const root = new RootContext();
    const host = new FakeHost();
    let layout!: LayoutService;
    let github!: GithubService;
    let agents!: AgentsService;
    await root.plugin({
      name: "github-tool-test",
      apply: (ctx: Context) => {
        layout = new LayoutService(ctx, "editor", null);
        github = new GithubService(ctx, {
          client: new GithubClient(issueGh),
          workspace: { selectedWorktree: () => null, repo: () => null, onSelectionChange: () => () => {} },
          layout,
          diffs: { showInEditor: async () => true, openTexts: async () => null, headText: async () => ({ exists: false, text: "" }) },
          openUrl: () => {},
        });
        const editor = new EditorService(ctx, new PathHost(), layout);
        agents = new AgentsService(ctx, host, layout, new FakeWorkspace(), undefined, serviceOpeners(editor, { ...noEditDiffs, showInEditor: async () => true }, github));
      },
    });
    agents.registerTools(groveTools(agents));
    await agents.ensureStarted();
    return { host, layout, github, agents };
  }

  test("a call opens a GitHub pane on the item, in the repository the card names", async () => {
    const { host, layout, github } = await setUpWithGithub();
    const result = await host.tools.call("openIssue", { repo: "other/thing", number: 9, kind: "issue" });
    expect(result).toBe("Opened issue other/thing#9 in Grove");
    const leaves = layout.leafIds().filter((leafId) => layout.paneTypeOf(leafId) === GITHUB_PANE_TYPE);
    expect(leaves).toHaveLength(1);
    const view = github.view(leaves[0]);
    expect(view.repo).toBe("other/thing");
    expect(view.place.item).toEqual({ kind: "issue", number: 9 });
    expect(view.item.detail?.title).toBe("Crash on save");
    expect(layout.focusedLeafId).toBe(leaves[0]);
  });

  test("a second call reuses the pane", async () => {
    const { host, layout } = await setUpWithGithub();
    await host.tools.call("openIssue", { repo: "other/thing", number: 9, kind: "issue" });
    await host.tools.call("openIssue", { repo: "other/thing", number: 9 });
    expect(layout.leafIds().filter((leafId) => layout.paneTypeOf(leafId) === GITHUB_PANE_TYPE)).toHaveLength(1);
  });

  test("a call without a kind says it was looked up", async () => {
    const { host } = await setUpWithGithub();
    expect(await host.tools.call("openIssue", { repo: "other/thing", number: 9 })).toBe("Opened other/thing#9 in Grove");
  });

  test("a call that names no repository, a bad number or an unknown kind fails with a message the agent can read", async () => {
    const { host } = await setUpWithGithub();
    await expect(host.tools.call("openIssue", { number: 9 })).rejects.toThrow("owner/name");
    await expect(host.tools.call("openIssue", { repo: "not a repo", number: 9 })).rejects.toThrow("owner/name");
    await expect(host.tools.call("openIssue", { repo: "a/b", number: 0 })).rejects.toThrow("number");
    await expect(host.tools.call("openIssue", { repo: "a/b", number: 1.5 })).rejects.toThrow("number");
    await expect(host.tools.call("openIssue", { repo: "a/b", number: 1, kind: "discussion" })).rejects.toThrow("issue or pull");
  });

  test("an app without a GitHub pane says so instead of pretending", async () => {
    const { host, agents } = await setUpWithCards();
    await agents.ensureStarted();
    await expect(host.tools.call("openIssue", { repo: "a/b", number: 1, kind: "issue" })).rejects.toThrow("no GitHub pane");
  });
});
