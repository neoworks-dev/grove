// The agents plugin: Grove as a client of the neoworks-harness suite daemon. It adds the Agents
// view to the rail, with the sessions of the open repository, and the `agent` pane type, which
// shows one session's chat over its composer. Sessions are the daemon's, so the same session
// shows up in `suite attach` and the suite's other windows.

import type { Context } from "@neoworks/extension-system";
import robot from "@phosphor-icons/core/regular/robot.svg";
import AgentPane from "./AgentPane.svelte";
import { sidecarChanges } from "./changesSource";
import { chatView } from "./chat/viewState";
import { AGENT_PANE_TYPE, AgentsService } from "./service";
import SessionsView from "./SessionsView.svelte";
import { createSuiteHost } from "./suiteHost";

export const agents = {
  name: "agents",
  inject: ["slots", "sidebar", "workspace", "commands", "keymap", "layout", "sidecar"],
  apply(ctx: Context) {
    const service = new AgentsService(ctx, createSuiteHost(), ctx.layout, ctx.workspace);
    ctx.slots.register("main", {
      id: "agent",
      key: AGENT_PANE_TYPE,
      component: AgentPane,
      props: {
        title: (leafId: string) => service.paneTitle(leafId),
        icon: robot,
        agents: service,
        layout: ctx.layout,
        workspace: ctx.workspace,
        changes: sidecarChanges(ctx.sidecar),
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
    registerCommands(ctx, service);
  },
};

/** Registers the commands for showing the view, starting a session, and what the chat shows, and the keys for the first two. */
function registerCommands(ctx: Context, service: AgentsService): void {
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
  ctx.keymap.bind([
    { id: "agents.show", keys: "ctrl+shift+a", command: "agents.show", description: "Show agents" },
    { id: "agents.newSession", keys: "ctrl+alt+n", command: "agents.newSession", description: "New agent session" },
  ]);
}
