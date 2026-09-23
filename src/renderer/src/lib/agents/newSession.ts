// What a session starts with when the user did not pick anything for it, and
// starting one on a task: shared by the Agent pane and the New worktree dialog.

import { settings } from '../settings.svelte'
import { layout } from '../layout.svelte'
import { selectWorktree } from '../store.svelte'
import { catalog } from './catalog.svelte'
import { agentSessions } from './sessions.svelte'
import type { ThinkingLevel } from './types'

/** The harness a new session runs: the last one chosen, else the first that can actually run. */
export function defaultSessionHarness(): string {
  const chosen = settings.get<string>('workbench.agentHarness')
  if (chosen) {
    return chosen
  }
  const firstAvailable = catalog.available[0]
  if (!firstAvailable) {
    return ''
  }
  return firstAvailable.id
}

/**
 * The effort a new session opens on. Chosen levels are remembered in settings as
 * well as on the session, so the next one starts where the last was left instead
 * of back at "off".
 */
export function defaultSessionThinking(): ThinkingLevel {
  const remembered = settings.get<ThinkingLevel>('workbench.agentThinking')
  if (remembered === undefined) {
    return 'off'
  }
  return remembered
}

/**
 * Starts a session in a worktree on the given prompt and shows it in the Agent
 * pane. The session is named after the prompt. Returns the session's id, or
 * null when the agent server could not create it.
 */
export async function startSessionWithTask(
  worktreePath: string,
  prompt: string
): Promise<string | null> {
  const harness = defaultSessionHarness()
  const sessionId = await agentSessions.create(worktreePath, {
    harness: harness || undefined,
    thinkingLevel: defaultSessionThinking()
  })
  if (!sessionId) {
    return null
  }
  await agentSessions.open(sessionId)
  await agentSessions.send(sessionId, [
    { type: 'user.message', content: [{ type: 'text', text: prompt }], deliverAs: 'steer' }
  ])
  // create() made it the worktree's active session, which is what the Agent
  // pane shows once the worktree is selected.
  await selectWorktree(worktreePath)
  layout.ensurePane('agent')
  return sessionId
}
