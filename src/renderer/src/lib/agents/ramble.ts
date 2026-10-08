// Rambles from the desktop overlay: the user talked while using their
// desktop, and this window had focus when they sent it. It goes to the agent
// on screen for the selected worktree, as one message with the screenshots
// attached, the same way the composer sends one.

import type { RambleDelivery, RambleReceipt } from '../../../../shared/ramble'
import { store } from '../store.svelte'
import { agentSessions } from './sessions.svelte'
import type { UserContentBlock } from './types'

/** Takes rambles until the returned function is called. */
export function receiveRambles(): () => void {
  return window.workbench.on('event:ramble', (payload) => {
    void answer(payload as RambleDelivery)
  })
}

async function answer(delivery: RambleDelivery): Promise<void> {
  let receipt: RambleReceipt
  try {
    receipt = await sendToAgent(delivery)
  } catch (error) {
    receipt = { sessionId: null, error: error instanceof Error ? error.message : String(error) }
  }
  await window.workbench.ramble.receipt(delivery.id, receipt)
}

async function sendToAgent(delivery: RambleDelivery): Promise<RambleReceipt> {
  const worktree = store.selectedWorktree
  if (!worktree) {
    return { sessionId: null, error: 'no worktree open' }
  }
  const sessionId = await agentSessions.ensureFor(worktree.path)
  if (!sessionId) {
    return { sessionId: null, error: 'could not start a session' }
  }
  const content: UserContentBlock[] = [{ type: 'text', text: delivery.text }]
  for (const image of delivery.images) {
    const blob = await window.workbench.agents.uploadBlob(sessionId, image.bytes, 'image/png', image.filename)
    content.push({ type: 'image', ref: blob.ref, mediaType: blob.mediaType })
  }
  await agentSessions.send(sessionId, [{ type: 'user.message', content, deliverAs: 'steer' }])
  return { sessionId }
}
