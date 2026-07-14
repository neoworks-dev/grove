// Per-worktree chat channel shared by the user and every agent running in that
// worktree. Agents post/read via the built-in `grove-chat` MCP tools; the user
// posts via IPC. Messages are stored (for history/catch-up), broadcast to the
// UI, and — for running recipients — injected into their live turn so they
// notice without polling. A per-worktree rate limit keeps agent↔agent chatter
// from looping into a runaway.

import { randomUUID } from 'crypto'
import type { WorktreeChatMessage } from '../../shared/types'

const MAX_HISTORY = 500

export interface ChannelEvents {
  onMessage: (message: WorktreeChatMessage) => void
}

export class WorktreeChannel {
  private history = new Map<string, WorktreeChatMessage[]>()

  constructor(
    private events: ChannelEvents,
    private now: () => number = () => Date.now()
  ) {}

  post(
    worktreeId: string,
    from: { kind: 'user' | 'agent'; name: string },
    text: string,
    to?: string
  ): WorktreeChatMessage {
    const message: WorktreeChatMessage = {
      id: randomUUID(),
      worktreeId,
      from,
      text,
      ts: this.now(),
      to
    }
    const list = this.history.get(worktreeId) ?? []
    list.push(message)
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY)
    this.history.set(worktreeId, list)
    this.events.onMessage(message)
    return message
  }

  // Messages for a worktree, optionally only those newer than `since` (ms epoch).
  list(worktreeId: string, since?: number): WorktreeChatMessage[] {
    const list = this.history.get(worktreeId) ?? []
    if (since === undefined) return [...list]
    return list.filter((message) => message.ts > since)
  }
}
