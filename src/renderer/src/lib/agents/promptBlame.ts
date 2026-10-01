// Opening the conversation a blamed line or commit came from.

import { agentSessions } from './sessions.svelte'
import { revealTurn } from './transcriptReveal.svelte'
import { layout } from '../layout.svelte'
import { selectWorktree } from '../store.svelte'
import { dialogs } from '../dialogs.svelte'
import { ageLabel } from '../time'
import type { PromptAttribution } from '../../../../shared/agents'

/**
 * Shows the conversation a prompt came from, at the turn that asked it. A
 * session that has since been deleted is shown as the prompt it kept.
 */
export async function openPrompt(attribution: PromptAttribution): Promise<void> {
  // The attribution may have been read before the session was deleted.
  await agentSessions.refreshList()
  const meta = agentSessions.list.find((session) => session.id === attribution.sessionId)
  if (!meta) {
    await showKeptPrompt(attribution)
    return
  }
  agentSessions.setActive(meta.workspaceRoot, meta.id)
  await selectWorktree(meta.workspaceRoot)
  layout.ensurePane('agent')
  if (attribution.turnSeq !== null) revealTurn(meta.id, attribution.turnSeq)
}

/** The prompt as blame kept it, for a session that no longer exists. */
async function showKeptPrompt(attribution: PromptAttribution): Promise<void> {
  let from = attribution.from
  if (from.length === 0) from = 'Unknown'
  await dialogs.confirm({
    title: `Written for “${attribution.sessionTitle}”`,
    body: `The session has been deleted. ${from} asked this ${ageLabel(attribution.at)}:`,
    detail: attribution.prompt,
    actions: [{ id: 'close', label: 'Close', kind: 'primary' }]
  })
}
