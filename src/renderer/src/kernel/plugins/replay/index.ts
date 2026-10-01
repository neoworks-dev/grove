// Session replay: an agent session's turns and edits, stepped through one at a
// time, as a pane of its own.

import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon'
import type { Context } from '@neoworks/extension-system'
import ReplayPane from './ReplayPane.svelte'
import { replaySession } from './target.svelte'
import { agentSessions } from '../../../lib/agents/sessions.svelte'
import { store } from '../../../lib/store.svelte'
import { repoOpen } from '../guards'

export const REPLAY_PANE = 'agent-replay'

export const replay = {
  name: 'core/replay',
  inject: ['panes', 'commands', 'layout'],

  apply(ctx: Context): void {
    ctx.effect(
      () =>
        ctx.panes.register({
          id: REPLAY_PANE,
          title: 'Session Replay',
          icon: FilmStripIcon,
          component: ReplayPane,
          containerClass: 'bg-surface',
          minWidth: 260,
          minHeight: 160,
          keywords: 'agent session replay timeline steps edits history rollback',
          when: repoOpen
        }),
      'pane:agent-replay'
    )

    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'agents.replaySession',
          title: 'Replay Agent Session',
          group: 'Agents',
          keywords: 'timeline steps edits history rollback',
          run: () => {
            const worktree = store.selectedWorktree
            if (worktree) {
              const sessionId = agentSessions.resolveActive(worktree.path)
              if (sessionId) replaySession(sessionId)
            }
            ctx.layout.ensurePane(REPLAY_PANE)
          }
        }),
      'command:agents.replaySession'
    )
  }
}
