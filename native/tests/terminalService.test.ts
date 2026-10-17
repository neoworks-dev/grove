import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import type { Worktree } from "../../src/shared/types";
import { LayoutService } from "../plugins/layout/service";
import {
  TerminalService,
  type TerminalEditor,
  type TerminalEvent,
  type TerminalHost,
  type TerminalPanel,
} from "../plugins/terminal/service";

/** A host that remembers which terminals were killed and lets a test send it events. */
class FakeHost implements TerminalHost {
  killed: string[] = [];
  directories = new Map<string, string>();
  private handlers = new Set<(event: TerminalEvent) => void>();

  async kill(id: string): Promise<void> {
    this.killed.push(id);
  }

  async workingDirectory(id: string): Promise<string | null> {
    return this.directories.get(id) ?? null;
  }

  onEvent(handler: (event: TerminalEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: TerminalEvent): void {
    for (const handler of [...this.handlers]) {
      handler(event);
    }
  }
}

/** A bottom panel that keeps whether it is open and which tab it shows. */
class FakePanel implements TerminalPanel {
  open_ = false;
  tab = "";

  isOpen(): boolean {
    return this.open_;
  }

  activeId(): string {
    return this.tab;
  }

  open(): void {
    this.open_ = true;
  }

  close(): void {
    this.open_ = false;
  }

  select(tabId: string): void {
    this.tab = tabId;
  }
}

/** An editor that records the files it was asked to show. */
class FakeEditor implements TerminalEditor {
  revealed: { path: string; line: number; character: number }[] = [];
  opened: string[] = [];

  async reveal(path: string, line: number, character: number): Promise<void> {
    this.revealed.push({ path, line, character });
  }

  async openPath(path: string): Promise<number | null> {
    this.opened.push(path);
    return 1;
  }
}

/** A worktree as the workspace lists it. */
function worktree(name: string, path: string): Worktree {
  return { id: name, name, path, branch: name, isMain: false, isDetached: false, locked: false, dirty: false, portSlot: 0 };
}

interface Setup {
  service: TerminalService;
  host: FakeHost;
  panel: FakePanel;
  editor: FakeEditor;
  layout: LayoutService;
  workspace: { selected: Worktree | null; selectedWorktree(): Worktree | null };
}

/** The service over fakes, in a layout with one editor pane and a workspace on the `main` worktree. */
async function setUp(): Promise<Setup> {
  const root = new RootContext();
  const host = new FakeHost();
  const panel = new FakePanel();
  const editor = new FakeEditor();
  const workspace = {
    selected: worktree("main", "/repo") as Worktree | null,
    selectedWorktree() {
      return this.selected;
    },
  };
  let layout!: LayoutService;
  let service!: TerminalService;
  await root.plugin({
    name: "terminal-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      service = new TerminalService(ctx, host, workspace, panel, layout, editor);
    },
  });
  return { service, host, panel, editor, layout, workspace };
}

describe("the panel", () => {
  test("toggling opens the panel on a terminal that starts in the selected worktree", async () => {
    const { service, panel } = await setUp();
    service.togglePanel();
    expect(panel.isOpen()).toBe(true);
    expect(panel.activeId()).toBe("terminal");
    const [first] = service.panelTerminals();
    expect(first.cwd).toBe("/repo");
    expect(service.activePanelTerminal()?.id).toBe(first.id);
    expect(service.focusRequest()).toBe(first.id);
  });

  test("toggling again hides the panel and keeps the shell", async () => {
    const { service, panel, host } = await setUp();
    service.togglePanel();
    service.togglePanel();
    expect(panel.isOpen()).toBe(false);
    expect(service.panelTerminals()).toHaveLength(1);
    expect(host.killed).toEqual([]);
  });

  test("toggling while another tab is shown switches to the terminal instead of hiding the panel", async () => {
    const { service, panel } = await setUp();
    panel.open();
    panel.select("problems");
    service.togglePanel();
    expect(panel.isOpen()).toBe(true);
    expect(panel.activeId()).toBe("terminal");
  });

  test("a new terminal is a second tab and becomes the one shown", async () => {
    const { service } = await setUp();
    service.togglePanel();
    const second = service.newPanelTerminal();
    expect(service.panelTerminals()).toHaveLength(2);
    expect(service.activePanelTerminal()?.id).toBe(second);
  });

  test("each worktree has its own terminals, and they come back when it is selected again", async () => {
    const { service, workspace } = await setUp();
    service.togglePanel();
    const mainTerminal = service.panelTerminals()[0];
    workspace.selected = worktree("feature", "/repo/.worktrees/feature");
    expect(service.panelTerminals()).toEqual([]);
    const featureId = service.newPanelTerminal();
    expect(service.terminal(featureId)?.cwd).toBe("/repo/.worktrees/feature");
    workspace.selected = worktree("main", "/repo");
    expect(service.panelTerminals().map((info) => info.id)).toEqual([mainTerminal.id]);
  });

  test("a terminal opened with no repository starts with no directory, which the host takes as home", async () => {
    const { service, workspace } = await setUp();
    workspace.selected = null;
    const id = service.newPanelTerminal();
    expect(service.terminal(id)?.cwd).toBe("");
  });

  test("closing a tab kills its shell and shows its neighbour", async () => {
    const { service, host } = await setUp();
    const first = service.newPanelTerminal();
    const second = service.newPanelTerminal();
    service.close(second);
    expect(host.killed).toEqual([second]);
    expect(service.activePanelTerminal()?.id).toBe(first);
  });

  test("closing the last tab hides the panel", async () => {
    const { service, panel } = await setUp();
    const only = service.newPanelTerminal();
    service.close(only);
    expect(panel.isOpen()).toBe(false);
  });
});

describe("what a shell reports", () => {
  test("a title from the shell names the tab", async () => {
    const { service, host } = await setUp();
    const id = service.newPanelTerminal();
    expect(service.terminal(id)?.title).toBe("shell");
    host.emit({ type: "title", id, title: "vim notes.md" });
    expect(service.panelTerminals()[0].title).toBe("vim notes.md");
  });

  test("a shell that exits closes its tab, and the panel with the last one", async () => {
    const { service, host, panel } = await setUp();
    const first = service.newPanelTerminal();
    const second = service.newPanelTerminal();
    host.emit({ type: "exit", id: second, code: 0 });
    expect(service.panelTerminals().map((info) => info.id)).toEqual([first]);
    expect(panel.isOpen()).toBe(true);
    host.emit({ type: "exit", id: first, code: 0 });
    expect(service.panelTerminals()).toEqual([]);
    expect(panel.isOpen()).toBe(false);
  });

  test("a bell marks a tab that is not in front, and showing the tab clears it", async () => {
    const { service, host } = await setUp();
    const first = service.newPanelTerminal();
    const second = service.newPanelTerminal();
    host.emit({ type: "bell", id: first });
    host.emit({ type: "bell", id: second });
    expect(service.terminal(first)?.bell).toBe(true);
    expect(service.terminal(second)?.bell).toBe(false);
    service.selectPanelTerminal(first);
    expect(service.terminal(first)?.bell).toBe(false);
  });

  test("events for a terminal that is gone are ignored", async () => {
    const { service, host } = await setUp();
    host.emit({ type: "exit", id: "nobody", code: 1 });
    expect(service.panelTerminals()).toEqual([]);
  });
});

describe("panes", () => {
  test("a terminal pane gets a shell of its own, started where the worktree is", async () => {
    const { service, layout } = await setUp();
    service.openInPane("row");
    const leafId = layout.focusedLeafId;
    expect(layout.paneTypeOf(leafId)).toBe("terminal");
    const info = service.ensurePaneTerminal(leafId);
    expect(info.leafId).toBe(leafId);
    expect(info.cwd).toBe("/repo");
    expect(service.paneTerminal(leafId)?.id).toBe(info.id);
    expect(service.ensurePaneTerminal(leafId).id).toBe(info.id);
    expect(service.panelTerminals()).toEqual([]);
  });

  test("closing the pane kills its shell", async () => {
    const { service, layout, host } = await setUp();
    service.openInPane("row");
    const leafId = layout.focusedLeafId;
    const info = service.ensurePaneTerminal(leafId);
    layout.closeLeaf(leafId);
    expect(host.killed).toEqual([info.id]);
    expect(service.terminal(info.id)).toBeNull();
  });

  test("a shell that exits closes its pane while another pane is open", async () => {
    const { service, layout, host } = await setUp();
    service.openInPane("row");
    const leafId = layout.focusedLeafId;
    const info = service.ensurePaneTerminal(leafId);
    host.emit({ type: "exit", id: info.id, code: 0 });
    expect(layout.leafIds()).not.toContain(leafId);
  });

  test("the only pane stays and offers a new shell", async () => {
    const { service, layout, host } = await setUp();
    const onlyLeaf = layout.focusedLeafId;
    const info = service.ensurePaneTerminal(onlyLeaf);
    host.emit({ type: "exit", id: info.id, code: 0 });
    expect(layout.leafIds()).toEqual([onlyLeaf]);
    expect(service.paneTerminal(onlyLeaf)?.exited).toBe(true);
    const replacement = service.ensurePaneTerminal(onlyLeaf, true);
    expect(replacement.id).not.toBe(info.id);
    expect(replacement.exited).toBe(false);
  });
});

describe("links", () => {
  test("a file with a line and column opens in an editor pane with the cursor there, counted from zero", async () => {
    const { service, editor, layout } = await setUp();
    const editorLeaf = layout.focusedLeafId;
    service.openInPane("row");
    expect(layout.focusedLeafId).not.toBe(editorLeaf);
    await service.openFile("/repo/src/main.rs", 12, 5);
    expect(editor.revealed).toEqual([{ path: "/repo/src/main.rs", line: 11, character: 4 }]);
    expect(layout.focusedLeafId).toBe(editorLeaf);
  });

  test("a file without a position is just opened", async () => {
    const { service, editor } = await setUp();
    await service.openFile("/repo/README.md", null, null);
    expect(editor.opened).toEqual(["/repo/README.md"]);
    expect(editor.revealed).toEqual([]);
  });
});
