// Agents: the cross-worktree overview in the sidebar, the transcript pane the
// right dock hosts, and the per-worktree chat pane.

import Robot from 'phosphor-svelte/lib/Robot'
import ChatCircle from 'phosphor-svelte/lib/ChatCircle'
import TerminalWindow from 'phosphor-svelte/lib/TerminalWindow'
import type { Context } from '@neoworks/extension-system'
import AgentsOverview from './AgentsOverview.svelte'
import AgentPane from './agent/AgentPane.svelte'
import AgentShellPane from './AgentShellPane.svelte'
import WorktreeChatPane from './WorktreeChatPane.svelte'
import { initHarnessIcons } from '../../../lib/agents/harnessIcons'
import { repoOpen } from '../guards'
import { registerCoreShowHandlers, reportPaneTypes } from './screen.svelte'

export const agents = {
  name: 'core/agents',
  inject: ['sidebar', 'panes', 'panel'],

  apply(ctx: Context): void {
    initHarnessIcons()

    // What agents can put in front of the user, and the panes they can ask for.
    ctx.effect(() => registerCoreShowHandlers(), 'agents:show-handlers')
    ctx.effect(() => reportPaneTypes(), 'agents:pane-types')

    ctx.effect(
      () =>
        ctx.sidebar.registerView({
          id: 'agents',
          title: 'Agents',
          icon: Robot,
          order: 4,
          component: AgentsOverview,
          when: repoOpen
        }),
      'sidebar:agents'
    )

    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'agent',
          title: 'Agent',
          component: AgentPane,
          containerClass: 'bg-surface',
          minWidth: 240,
          // Opens against the right edge when nothing of it is showing; from
          // there it drags and splits like any other window.
          preferredEdge: { side: 'right', order: 0, fraction: 0.24 },
          // A transcript reads fine narrow, so the agent panel is the first to
          // give up room when another pane opens and the last to reclaim it.
          growth: 0.5,
          // Vim-style: 'normal' scrolls the transcript and navigates instances;
          // 'i' enters 'insert', which focuses the composer; Escape returns.
          modes: ['normal', 'insert']
        }),
      'pane:agent'
    )

    // What the session on screen's commands print, as they run. Beside the
    // shell terminal in the bottom panel, and opened from a command's card.
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'agent-shell',
          title: 'Agent terminal',
          icon: TerminalWindow,
          component: AgentShellPane,
          containerClass: 'bg-surface',
          minHeight: 120,
          ownsFontScale: true,
          keywords: 'agent terminal commands output bash shell running',
          when: repoOpen
        }),
      'pane:agent-shell'
    )
    ctx.effect(
      () =>
        ctx.panel.registerTab({
          id: 'agent-shell',
          title: 'Agent terminal',
          icon: TerminalWindow,
          paneTypeId: 'agent-shell',
          order: 15
        }),
      'panel:agent-shell'
    )

    // Opened from a pane's own menu or the worktree row's chat button; no rail
    // entry, and it yields the right edge to the agent panel.
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'worktree-chat',
          title: 'Worktree Chat',
          icon: ChatCircle,
          component: WorktreeChatPane,
          containerClass: 'bg-elevated',
          minWidth: 240,
          preferredEdge: { side: 'right', order: 10, fraction: 0.24 },
          when: repoOpen
        }),
      'pane:worktree-chat'
    )
  }
}
