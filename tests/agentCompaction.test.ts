// A compaction in the agent pane: one row that follows it from start to end,
// folded from ACP `compaction_update`s as the harness sends them.

import { describe, expect, test } from 'bun:test'
import {
  applyEvent,
  compacting,
  createTranscript,
  visibleItems,
  type CompactionItem,
  type TranscriptState
} from '../src/renderer/src/lib/agents/transcript'
import { compactionLabel } from '../src/renderer/src/lib/agents/compaction'
import type { EventBody } from '../src/renderer/src/lib/agents/types'

function fold(bodies: EventBody[]): TranscriptState {
  const state = createTranscript()
  bodies.forEach((body, index) => {
    const seq = index + 1
    applyEvent(state, {
      ...body,
      id: `evt_${seq}`,
      seq,
      sessionId: 's1',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
  })
  return state
}

function compactions(state: TranscriptState): CompactionItem[] {
  return visibleItems(state).filter((item): item is CompactionItem => item.kind === 'compaction')
}

function update(fields: Record<string, unknown>): EventBody {
  return {
    type: 'update',
    update: { sessionUpdate: 'compaction_update', compactionId: 'c1', ...fields }
  } as EventBody
}

const started = update({ status: 'in_progress', _meta: { contextCompaction: { version: 1 } } })
const running: EventBody = { type: 'session.status_running' }

describe('a compaction in the transcript', () => {
  test('shows from the moment it starts, and the working bar steps aside', () => {
    const state = fold([running, started])
    expect(compactions(state).map((item) => item.status)).toEqual(['running'])
    expect(compacting(state)).toBe(true)
    expect(compactionLabel(compactions(state)[0])).toBe('Compacting context…')
  })

  // The order claude-agent-acp sent for a `/compact`: the outcome with the
  // summary, then the outcome again to add the token counts.
  test('is one row however often the harness reports its outcome', () => {
    const state = fold([
      running,
      started,
      update({ status: 'completed', summary: [{ type: 'text', text: 'We said ok.' }] }),
      update({
        status: 'completed',
        _meta: {
          contextCompaction: { version: 1, trigger: 'manual', preTokens: 26746, postTokens: 3171 }
        }
      }),
      { type: 'session.status_idle', stopReason: 'end_turn' }
    ])
    const [compaction] = compactions(state)
    expect(compactions(state)).toHaveLength(1)
    expect(compaction.summary).toBe('We said ok.')
    expect(compactionLabel(compaction)).toBe('Context compacted · 26.7k → 3.2k tokens')
    expect(compacting(state)).toBe(false)
    expect(visibleItems(state).some((item) => item.kind === 'notice')).toBe(false)
  })

  test('streams its summary in as it is written', () => {
    const state = fold([
      started,
      {
        type: 'update',
        update: {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: 'c1',
          content: { type: 'text', text: 'First ' }
        }
      },
      {
        type: 'update',
        update: {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: 'c1',
          content: { type: 'text', text: 'part.' }
        }
      }
    ])
    expect(compactions(state)[0].summary).toBe('First part.')
  })

  test('says why it failed', () => {
    const state = fold([started, update({ status: 'failed', error: 'Not enough messages' })])
    expect(compactionLabel(compactions(state)[0])).toBe('Compaction failed: Not enough messages')
  })

  test('one the harness started on its own says so', () => {
    const state = fold([
      update({ status: 'in_progress', _meta: { contextCompaction: { trigger: 'automatic' } } })
    ])
    expect(compactionLabel(compactions(state)[0])).toBe(
      'Compacting context, which was nearly full…'
    )
  })

  test('ends with its turn when the harness never said it ended', () => {
    const state = fold([running, started, { type: 'session.status_idle', stopReason: 'error' }])
    expect(compactions(state)[0].status).toBe('cancelled')
    expect(compactionLabel(compactions(state)[0])).toBe('Compaction cancelled.')
  })
})
