// Agents: the cross-worktree overview in the sidebar, the transcript pane the
// right dock hosts, and the per-worktree chat pane.

import Robot from 'phosphor-svelte/lib/Robot'
import ChatCircle from 'phosphor-svelte/lib/ChatCircle'
import type { Context } from '@neoworks/extension-system'
import AgentsOverview from '../../components/AgentsOverview.svelte'
import AgentPane from '../../components/agent/AgentPane.svelte'
import WorktreeChatPane from '../../components/WorktreeChatPane.svelte'
import { repoOpen } from './guards'

export const agents = {
  name: 'core/agents',
  inject: ['sidebar', 'panes'],

  apply(ctx: Context): void {
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
          // Vim-style: 'normal' scrolls the transcript and navigates instances;
          // 'i' enters 'insert', which focuses the composer; Escape returns.
          modes: ['normal', 'insert']
        }),
      'pane:agent'
    )

    // Right-dock utility pane (chosen from the dock picker or the worktree
    // row's chat button); no rail entry and no sidebar slot so it docks right.
    ctx.effect(
      () =>
        ctx.panes.register({
          id: 'worktree-chat',
          title: 'Worktree Chat',
          icon: ChatCircle,
          component: WorktreeChatPane,
          containerClass: 'bg-elevated',
          minWidth: 240,
          when: repoOpen
        }),
      'pane:worktree-chat'
    )
  }
}
