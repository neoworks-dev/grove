// The session store is the source of truth for a transcript: the renderer folds
// its log, the review bridge watches it, and a restart replays it rather than
// asking a harness what happened. This pins the properties that rest on —
// sequence numbers never repeat, subscribers see every event, and a session
// survives being read back from disk.

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/main/agents/store'
import type { SessionEvent } from '../src/shared/agents'

async function withStore(run: (store: SessionStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'grove-agents-'))
  try {
    await run(new SessionStore(root), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function newSession(store: SessionStore): ReturnType<SessionStore['create']> {
  return store.create({
    workspaceRoot: '/tmp/worktree',
    harness: 'claude',
    title: 'Session 1',
    provider: 'anthropic',
    model: 'claude-opus-5',
    thinkingLevel: 'off',
    activeTools: null
  })
}

describe('SessionStore', () => {
  test('events are stamped with increasing sequence numbers', async () => {
    await withStore(async (store) => {
      const session = await newSession(store)
      const first = await store.append(session.id, { type: 'session.status_running' })
      const second = await store.append(session.id, {
        type: 'agent.message_delta',
        text: 'hello'
      })

      expect(first.seq).toBe(1)
      expect(second.seq).toBe(2)
      expect(second.sessionId).toBe(session.id)
    })
  })

  test('eventsSince replays only what a caller has not seen', async () => {
    await withStore(async (store) => {
      const session = await newSession(store)
      await store.append(session.id, { type: 'session.status_running' })
      await store.append(session.id, { type: 'agent.message_delta', text: 'a' })
      await store.append(session.id, { type: 'session.status_idle', stopReason: 'end_turn' })

      const gap = await store.eventsSince(session.id, 1)
      expect(gap.map((event) => event.seq)).toEqual([2, 3])
    })
  })

  test('subscribers see every event, and unsubscribing stops them', async () => {
    await withStore(async (store) => {
      const session = await newSession(store)
      const seen: SessionEvent[] = []
      const unsubscribe = store.subscribe((event) => seen.push(event))

      await store.append(session.id, { type: 'session.status_running' })
      unsubscribe()
      await store.append(session.id, { type: 'session.status_idle', stopReason: 'end_turn' })

      expect(seen.map((event) => event.type)).toEqual(['session.status_running'])
    })
  })

  test('a session and its log are read back from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grove-agents-'))
    try {
      const store = new SessionStore(root)
      const session = await newSession(store)
      await store.append(session.id, { type: 'agent.message_delta', text: 'persisted' })
      await store.patch(session.id, { resumeKey: 'thread-1' })
      await store.flush()

      const reopened = new SessionStore(root)
      const restored = await reopened.require(session.id)
      expect(restored.title).toBe('Session 1')
      expect(restored.harness).toBe('claude')
      expect(restored.resumeKey).toBe('thread-1')

      const events = await reopened.eventsSince(session.id, 0)
      expect(events).toHaveLength(1)
      expect(events[0].seq).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a deleted session leaves nothing behind', async () => {
    await withStore(async (store) => {
      const session = await newSession(store)
      await store.append(session.id, { type: 'session.status_running' })
      await store.flush()
      await store.remove(session.id)

      expect(await store.get(session.id)).toBeUndefined()
      expect(await store.list()).toEqual([])
    })
  })

  test('an unknown session is an error rather than an empty transcript', async () => {
    await withStore(async (store) => {
      await expect(store.require('nope')).rejects.toThrow('unknown agent session: nope')
    })
  })
})
