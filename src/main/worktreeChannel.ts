// Per-worktree chat channel shared by the user and every agent working in that
// worktree.
//
// The channel is a file — `.workbench/chat.jsonl` in the worktree — rather than
// memory, because the two sides of it live in different processes: the user
// posts through grove, and agents post through the grove-chat nib extension,
// which is in-process bun code inside the agent server with no way to call back
// here. A file is the one thing they both already have.
//
// grove watches that file so an agent's message reaches the UI without polling.
// The worktree watcher deliberately ignores `.workbench`, so this keeps its own.

import { randomUUID } from 'crypto'
import { watch, type FSWatcher } from 'fs'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { WorktreeChatMessage } from '../shared/types'

const MAX_HISTORY = 500

export const CHANNEL_FILE = join('.workbench', 'chat.jsonl')

export interface ChannelEvents {
  onMessage: (message: WorktreeChatMessage) => void
}

export function channelPathFor(worktreePath: string): string {
  return join(worktreePath, CHANNEL_FILE)
}

export class WorktreeChannel {
  // Last known contents per worktree, so a file change can be diffed down to the
  // messages that are actually new.
  private seen = new Map<string, WorktreeChatMessage[]>()
  private watchers = new Map<string, FSWatcher>()

  constructor(
    private events: ChannelEvents,
    private now: () => number = () => Date.now()
  ) {}

  /** Post a message and announce it. Returns the message as written. */
  async post(
    worktreeId: string,
    from: { kind: 'user' | 'agent'; name: string; instanceId?: string },
    text: string,
    to?: string
  ): Promise<WorktreeChatMessage> {
    const message: WorktreeChatMessage = {
      id: randomUUID(),
      worktreeId,
      from,
      text,
      ts: this.now(),
      to
    }
    const path = channelPathFor(worktreeId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(message)}\n`, 'utf8')

    this.seen.set(worktreeId, [...(this.seen.get(worktreeId) ?? []), message])
    this.events.onMessage(message)
    return message
  }

  /** Messages for a worktree, optionally only those newer than `since` (ms epoch). */
  async list(worktreeId: string, since?: number): Promise<WorktreeChatMessage[]> {
    const messages = await this.read(worktreeId)
    this.seen.set(worktreeId, messages)
    if (since === undefined) return messages
    return messages.filter((message) => message.ts > since)
  }

  /**
   * Follow a worktree's channel so messages written by an agent are announced.
   * Idempotent per worktree; dropped by `close`.
   */
  async watchWorktree(worktreeId: string): Promise<void> {
    if (this.watchers.has(worktreeId)) return
    const path = channelPathFor(worktreeId)
    await mkdir(dirname(path), { recursive: true })
    // Seed the baseline so pre-existing history is not replayed as new.
    this.seen.set(worktreeId, await this.read(worktreeId))

    try {
      const watcher = watch(path, { persistent: false }, () => {
        void this.announceNew(worktreeId)
      })
      watcher.on('error', () => this.close(worktreeId))
      this.watchers.set(worktreeId, watcher)
    } catch {
      // The file does not exist yet. The first post creates it, and the next
      // call to watchWorktree picks it up.
    }
  }

  close(worktreeId: string): void {
    this.watchers.get(worktreeId)?.close()
    this.watchers.delete(worktreeId)
  }

  closeAll(): void {
    for (const id of [...this.watchers.keys()]) this.close(id)
  }

  private async announceNew(worktreeId: string): Promise<void> {
    const before = this.seen.get(worktreeId) ?? []
    const after = await this.read(worktreeId)
    this.seen.set(worktreeId, after)

    const known = new Set(before.map((message) => message.id))
    for (const message of after) {
      if (!known.has(message.id)) this.events.onMessage(message)
    }
  }

  private async read(worktreeId: string): Promise<WorktreeChatMessage[]> {
    const text = await readFile(channelPathFor(worktreeId), 'utf8').catch(() => '')
    const messages: WorktreeChatMessage[] = []
    for (const line of text.split('\n')) {
      const message = parseMessage(line, worktreeId)
      if (message) messages.push(message)
    }
    if (messages.length > MAX_HISTORY) return messages.slice(-MAX_HISTORY)
    return messages
  }
}

/**
 * One line of the channel file. The agent side writes it too, so a malformed or
 * half-written line is skipped rather than failing the whole read.
 */
function parseMessage(line: string, worktreeId: string): WorktreeChatMessage | null {
  if (line.trim().length === 0) return null
  try {
    const parsed = JSON.parse(line) as Partial<WorktreeChatMessage>
    if (typeof parsed.text !== 'string' || !parsed.from) return null
    return {
      id: typeof parsed.id === 'string' ? parsed.id : randomUUID(),
      worktreeId,
      from: parsed.from,
      text: parsed.text,
      ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
      to: parsed.to
    }
  } catch {
    return null
  }
}
