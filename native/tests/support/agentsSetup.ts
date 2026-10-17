// The agents service over a fake daemon, in a layout with one editor pane and a workspace with
// a repository at `/repo` and one more worktree under it.

import { Context as RootContext, type Context } from "@neoworks/extension-system";
import type { Worktree } from "../../../src/shared/types";
import { LayoutService } from "../../plugins/layout/service";
import { AgentsService, type AgentsTiming, type AgentWorkspace } from "../../plugins/agents/service";
import { FakeHost } from "./fakeSuite";

/** A worktree as the workspace lists it. */
export function worktree(name: string, path: string, isMain = false): Worktree {
  return { id: name, name, path, branch: name, isMain, isDetached: false, locked: false, dirty: false, portSlot: 0 };
}

/** A workspace with a repository at `/repo` and one more worktree under `.worktrees`. */
export class FakeWorkspace implements AgentWorkspace {
  list = [worktree("main", "/repo", true), worktree("feature", "/repo/.worktrees/feature")];
  selectedId = "main";

  worktrees(): Worktree[] {
    return this.list;
  }

  selectedWorktree(): Worktree | null {
    return this.list.find((candidate) => candidate.id === this.selectedId) ?? null;
  }
}

export interface AgentsSetup {
  host: FakeHost;
  layout: LayoutService;
  workspace: FakeWorkspace;
  agents: AgentsService;
}

/** A layout with one editor pane, a workspace, and the agents service over a fake daemon. */
export async function setUpAgents(timing?: AgentsTiming): Promise<AgentsSetup> {
  const root = new RootContext();
  const host = new FakeHost();
  const workspace = new FakeWorkspace();
  let layout!: LayoutService;
  let agents!: AgentsService;
  await root.plugin({
    name: "agents-test",
    apply: (ctx: Context) => {
      layout = new LayoutService(ctx, "editor", null);
      agents = new AgentsService(ctx, host, layout, workspace, timing);
    },
  });
  return { host, layout, workspace, agents };
}
