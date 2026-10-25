// The agents plugin: Grove as a client of the neoworks-harness suite daemon. It adds the Agents
// view to the rail, with the sessions of the open repository, and the `agent` pane type, which
// shows one session's chat over its composer. Sessions are the daemon's, so the same session
// shows up in `suite attach` and the suite's other windows.

import type { Context } from "@neoworks/extension-system";
import robot from "@phosphor-icons/core/regular/robot.svg";
import AgentPane from "./AgentPane.svelte";
import { sidecarChanges } from "./changesSource";
import { chatView } from "./chat/viewState";
import { groveComponents } from "./groveComponents";
import { groveTools } from "./groveTools";
import { AGENT_PANE_TYPE, AgentsService, serviceOpeners } from "./service";
import SessionsView from "./SessionsView.svelte";
import { createSuiteHost } from "./suiteHost";

export const agents = {
  name: "agents",
  inject: ["slots", "sidebar", "workspace", "commands", "keymap", "layout", "sidecar", "editor", "diff", "explorer", "github"],
  apply(ctx: Context) {
    const service = new AgentsService(ctx, createSuiteHost(), ctx.layout, ctx.workspace, undefined, serviceOpeners(ctx.editor, ctx.diff, ctx.github));
    ctx.effect(() => service.registerTools(groveTools(service)), "agents.tools");
    ctx.effect(() => service.registerComponents(groveComponents), "agents.components");
    ctx.slots.register("main", {
      id: "agent",
      key: AGENT_PANE_TYPE,
      component: AgentPane,
      props: {
        title: (leafId: string) => service.paneTitle(leafId),
        icon: robot,
        header: false,
        agents: service,
        layout: ctx.layout,
        workspace: ctx.workspace,
        changes: sidecarChanges(ctx.sidecar),
        icons: ctx.explorer,
      },
    });
    ctx.sidebar.registerView({
      id: "agents",
      title: "Agents",
      icon: robot,
      order: 4,
      component: SessionsView,
      props: { agents: service, workspace: ctx.workspace },
    });
    // Under the list of files; a plugin adds what belongs to the session's changes, such as sending a review.
    ctx.slots.declare("agents.files.review", "list");
    registerCommands(ctx, service);
    openChatOnStart(ctx, service);
  },
};

/**
 * Opens a fresh chat beside the editor once the first repository is open, as Grove's default
 * layout. The pane closes like any other; the editor keeps the focus.
 */
function openChatOnStart(ctx: Context, service: AgentsService): void {
  const stop = ctx.workspace.onSelectionChange((worktree: unknown) => {
    if (worktree === null) {
      return;
    }
    stop();
    const editorLeafId = ctx.layout.focusedLeafId;
    void service.newSession().then(() => ctx.layout.focus(editorLeafId));
  });
}

/** Registers the commands for showing the view, starting a session, what the chat shows and the approvals mode, and their keys. */
function registerCommands(ctx: Context, service: AgentsService): void {
  const inAgentPane = (): boolean => service.focusedAgentPane() !== null;
  ctx.commands.register({ id: "agents.show", title: "Show agents", group: "View", run: () => ctx.sidebar.open("agents") });
  ctx.commands.register({
    id: "agents.newSession",
    title: "New agent session",
    group: "Agents",
    run: () => void service.newSession(),
  });
  ctx.commands.register({
    id: "agents.toggleResults",
    title: "Agents: toggle full tool results",
    group: "Agents",
    run: () => chatView.toggleExpanded(),
  });
  ctx.commands.register({
    id: "agents.toggleThoughts",
    title: "Agents: toggle the agent's thoughts",
    group: "Agents",
    run: () => chatView.toggleThoughts(),
  });
  ctx.commands.register({
    id: "agents.cycleApprovals",
    title: "Agents: next approvals mode (ask, review, edits, auto)",
    group: "Agents",
    run: () => void service.focusedChat()?.cycleApprovals(),
  });
  ctx.commands.register({
    id: "agents.toggleEdits",
    title: "Agents: show or hide the plan and files",
    group: "Agents",
    run: () => service.focusedPane()?.togglePanel(),
  });
  ctx.commands.register({
    id: "agents.focusAgents",
    title: "Agents: move to the list of agents",
    group: "Agents",
    run: () => void service.focusedPane()?.focusAgents(),
  });
  ctx.commands.register({
    id: "agents.previousSession",
    title: "Agents: previous session",
    group: "Agents",
    run: () => service.stepSession(-1),
  });
  ctx.commands.register({
    id: "agents.nextSession",
    title: "Agents: next session",
    group: "Agents",
    run: () => service.stepSession(1),
  });
  ctx.keymap.bind([
    { id: "agents.show", keys: "ctrl+shift+a", command: "agents.show", description: "Show agents" },
    { id: "agents.newSession", keys: "ctrl+alt+n", command: "agents.newSession", description: "New agent session" },
    { id: "agents.previousSession", keys: "alt+h", command: "agents.previousSession", description: "Previous session", when: inAgentPane },
    { id: "agents.nextSession", keys: "alt+l", command: "agents.nextSession", description: "Next session", when: inAgentPane },
    { id: "agents.toggleEdits", keys: "alt+e", command: "agents.toggleEdits", description: "Plan and files", when: inAgentPane },
    { id: "agents.focusAgents", keys: "ctrl+x", command: "agents.focusAgents", description: "List of agents", when: inAgentPane },
    // Keys other panes use too (Ctrl-O opens a file in the editor): theirs while an agent pane has the focus.
    {
      id: "agents.toggleResults",
      keys: "ctrl+o",
      command: "agents.toggleResults",
      description: "Full tool results",
      when: () => service.focusedAgentPane() !== null,
    },
    {
      id: "agents.toggleThoughts",
      keys: "ctrl+t",
      command: "agents.toggleThoughts",
      description: "The agent's thoughts",
      when: () => service.focusedAgentPane() !== null,
    },
  ]);
}
