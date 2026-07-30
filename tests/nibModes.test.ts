import { describe, expect, test } from 'bun:test'
import {
  activeToolsFor,
  autoDecisionFor,
  modeOf,
  MUTATING_TOOLS
} from '../src/renderer/src/lib/nib/modes'
import type { SessionSnapshot } from '../src/renderer/src/lib/nib/types'

const ALL_TOOLS = ['read', 'glob', 'grep', 'edit', 'write', 'bash']

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    title: 'Session',
    workspaceRoot: '/repo',
    provider: 'anthropic',
    model: 'claude',
    thinkingLevel: 'high',
    activeTools: null,
    autoApproveTools: [],
    labels: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    pendingApprovals: [],
    messageCount: 0,
    lastSeq: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0,
    context: { usedTokens: 0, contextWindow: 200_000, remainingTokens: 200_000, ratio: 0 },
    queued: [],
    ...overrides
  }
}

describe('modeOf', () => {
  test('a session with everything available and nothing pre-approved is in default mode', () => {
    expect(modeOf(snapshot(), false)).toBe('default')
  })

  test('withholding every mutating tool reads as plan mode', () => {
    const activeTools = ALL_TOOLS.filter((tool) => !MUTATING_TOOLS.includes(tool))
    expect(modeOf(snapshot({ activeTools }), false)).toBe('plan')
  })

  test('withholding only some mutating tools is not plan mode', () => {
    expect(modeOf(snapshot({ activeTools: ['read', 'edit'] }), false)).toBe('default')
  })

  test('write and edit pre-approved for the session reads as accept-edits', () => {
    expect(modeOf(snapshot({ autoApproveTools: ['write', 'edit'] }), false)).toBe('acceptEdits')
  })

  test('only one of the two pre-approved is not accept-edits', () => {
    expect(modeOf(snapshot({ autoApproveTools: ['write'] }), false)).toBe('default')
  })

  test('bypass wins over whatever the session says, since it is the local override', () => {
    expect(modeOf(snapshot({ autoApproveTools: ['write', 'edit'] }), true)).toBe('bypass')
  })

  test('a session that has not loaded yet is default rather than undefined', () => {
    expect(modeOf(null, false)).toBe('default')
  })
})

describe('activeToolsFor', () => {
  test('plan mode withholds the tools that change something', () => {
    expect(activeToolsFor('plan', ALL_TOOLS)).toEqual(['read', 'glob', 'grep'])
  })

  test('every other mode restores the full set', () => {
    expect(activeToolsFor('default', ALL_TOOLS)).toBeNull()
    expect(activeToolsFor('acceptEdits', ALL_TOOLS)).toBeNull()
    expect(activeToolsFor('bypass', ALL_TOOLS)).toBeNull()
  })
})

describe('autoDecisionFor', () => {
  test('bypass answers everything, bash included', () => {
    expect(autoDecisionFor('bypass', 'bash', 'post')).toBe('allow')
    expect(autoDecisionFor('bypass', 'write', 'pre')).toBe('allow')
  })

  test('accept-edits remembers write and edit for the session', () => {
    expect(autoDecisionFor('acceptEdits', 'write', 'post')).toBe('always_session')
    expect(autoDecisionFor('acceptEdits', 'edit', 'post')).toBe('always_session')
  })

  test('accept-edits never covers bash', () => {
    expect(autoDecisionFor('acceptEdits', 'bash', 'post')).toBeNull()
  })

  test('accept-edits stands down while changes are reviewed before they are written', () => {
    expect(autoDecisionFor('acceptEdits', 'write', 'pre')).toBeNull()
  })

  test('default and plan always put the call to the user', () => {
    expect(autoDecisionFor('default', 'write', 'post')).toBeNull()
    expect(autoDecisionFor('plan', 'write', 'post')).toBeNull()
  })
})
