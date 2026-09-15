// Which sessions belong to which: what the tab strip and the overview draw the
// spawn relation from, and how a message's sender is turned back into a session.

import { describe, expect, test } from 'bun:test'
import {
  agentIdOf,
  liveAgentIds,
  parentIdOf,
  sessionByAgentId,
  sessionFamilies,
  subagentOf,
  subagentSessions
} from '../src/renderer/src/lib/agents/sessionTree'
import { agentIdIn, senderOf, type AppItem } from '../src/renderer/src/lib/agents/transcript'
import type { SessionMeta } from '../src/renderer/src/lib/agents/types'

function session(id: string, labels: Record<string, string> = {}): SessionMeta {
  return {
    id,
    title: id,
    workspaceRoot: '/repo',
    harness: 'claude',
    provider: 'anthropic',
    model: 'opus',
    thinkingLevel: 'off',
    activeTools: null,
    autoApproveTools: [],
    labels,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    pendingApprovals: [],
    lastSeq: 0,
    live: true
  }
}

function shape(sessions: SessionMeta[]): string[][] {
  return sessionFamilies(sessions).map((family) =>
    family.map((row) => `${row.session.id}@${row.depth}`)
  )
}

describe('grouping sessions into families', () => {
  test('a spawned session follows the one that spawned it', () => {
    const sessions = [
      session('planner'),
      session('other'),
      session('reviewer', { 'grove.parent': 'planner' })
    ]

    expect(shape(sessions)).toEqual([['planner@0', 'reviewer@1'], ['other@0']])
  })

  test('an agent spawned by a spawned agent nests one further', () => {
    const sessions = [
      session('planner'),
      session('builder', { 'grove.parent': 'planner' }),
      session('helper', { 'grove.parent': 'builder' })
    ]

    expect(shape(sessions)).toEqual([['planner@0', 'builder@1', 'helper@2']])
  })

  test('a session whose parent was deleted leads its own family', () => {
    const sessions = [session('orphan', { 'grove.parent': 'gone' })]

    expect(shape(sessions)).toEqual([['orphan@0']])
  })

  test('a session that somehow parents itself does not loop', () => {
    const sessions = [session('self', { 'grove.parent': 'self' })]

    expect(shape(sessions)).toEqual([['self@0']])
  })

  test('every session appears exactly once', () => {
    const sessions = [
      session('a'),
      session('b', { 'grove.parent': 'a' }),
      session('c', { 'grove.parent': 'a' }),
      session('d')
    ]

    const ids = sessionFamilies(sessions)
      .flat()
      .map((row) => row.session.id)

    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('finding the session behind an agent id', () => {
  test('matches the stamped id', () => {
    const sessions = [session('a', { 'grove.agentId': '155a4e' })]

    expect(sessionByAgentId(sessions, '155a4e')?.id).toBe('a')
  })

  test('matches the head of the session id for sessions stamped before ids existed', () => {
    const sessions = [session('0ed7347c-e404-4d22')]

    expect(agentIdOf(sessions[0])).toBe('0ed7347c')
    expect(sessionByAgentId(sessions, '0ed7347c')?.id).toBe('0ed7347c-e404-4d22')
  })

  test('has no parent to report when nothing spawned it', () => {
    expect(parentIdOf(session('a'))).toBeNull()
  })
})

describe('reading a sender back into an address', () => {
  function appItem(label: string, from?: string): AppItem {
    return { kind: 'app', seq: 1, eventId: 'e', label, text: 'pong', from }
  }

  test('takes the id out of the signature the sender is written as', () => {
    expect(agentIdIn('Echo (155a4e)')).toBe('155a4e')
  })

  test('has none for a sender grove wrote itself', () => {
    expect(agentIdIn('Review feedback')).toBeNull()
    expect(senderOf(appItem('Review feedback'))).toBeNull()
  })
})

describe('telling a live sender from a closed one', () => {
  test('holds every agent that still has a session, however it is addressed', () => {
    const live = liveAgentIds([session('aaaaaaaa11'), session('b', { 'grove.agentId': '155a4e' })])

    expect(live.has('155a4e')).toBe(true)
    // No label on the first one, so the head of its session id is its address.
    expect(live.has('aaaaaaaa')).toBe(true)
  })

  test('has nothing for an agent whose session was removed', () => {
    const live = liveAgentIds([session('a', { 'grove.agentId': '155a4e' })])

    expect(live.has('721e1d')).toBe(false)
  })
})

describe('an agent a harness ran inside a tool call', () => {
  test('names the call it was run by', () => {
    expect(subagentOf(session('a', { 'grove.subagentOf': 'toolu_1' }))).toBe('toolu_1')
    expect(subagentOf(session('b', { 'grove.parent': 'a' }))).toBeNull()
  })

  test('a tool call leads to the conversation it ran', () => {
    const sessions = [
      session('parent'),
      session('child', { 'grove.parent': 'parent', 'grove.subagentOf': 'toolu_1' }),
      session('spawned', { 'grove.parent': 'parent' })
    ]

    const byCall = subagentSessions(sessions)
    expect(byCall.get('toolu_1')).toBe('child')
    // A session spawned by the agent itself belongs to no call.
    expect(byCall.size).toBe(1)
  })

  test('it sits in the family of the session that ran it', () => {
    const sessions = [
      session('parent'),
      session('child', { 'grove.parent': 'parent', 'grove.subagentOf': 'toolu_1' })
    ]

    expect(shape(sessions)).toEqual([['parent@0', 'child@1']])
  })
})
