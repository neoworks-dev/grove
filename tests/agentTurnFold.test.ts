// Folding a finished turn down to its answer. What hides is the work; what stays
// is the last thing the agent said, plus anything that still wants the user.

import { describe, expect, test } from 'bun:test'
import { tallyOf, toTranscriptRows } from '../src/renderer/src/lib/agents/toolRuns'
import { foldedCalls, foldedMessages, foldTurn } from '../src/renderer/src/lib/agents/turns'
import type { ToolStatus, TranscriptItem } from '../src/renderer/src/lib/agents/transcript'

let nextEventId = 0

function agentMessage(text: string): TranscriptItem {
  nextEventId += 1
  return {
    kind: 'agent',
    seq: nextEventId,
    eventId: `e${nextEventId}`,
    text,
    thinking: '',
    streaming: false
  }
}

function toolCall(name: string, status: ToolStatus = 'ok'): TranscriptItem {
  nextEventId += 1
  return {
    kind: 'tool',
    seq: nextEventId,
    eventId: `e${nextEventId}`,
    toolUseId: `t${nextEventId}`,
    name,
    input: {},
    editedInput: null,
    permission: 'allow',
    result: '',
    status,
    progress: ''
  }
}

function notice(text: string): TranscriptItem {
  nextEventId += 1
  return { kind: 'notice', seq: nextEventId, eventId: `e${nextEventId}`, text, tone: 'error' }
}

describe('foldTurn', () => {
  test('hides the work and keeps the last answer', () => {
    const rows = toTranscriptRows([
      agentMessage('let me look'),
      toolCall('Read'),
      toolCall('Read'),
      toolCall('Edit'),
      agentMessage('done: renamed the field')
    ])
    const fold = foldTurn(rows)

    expect(fold.kept).toHaveLength(1)
    expect(fold.kept[0].kind === 'item' && fold.kept[0].item.kind === 'agent').toBe(true)
    expect(foldedMessages(fold.hidden).map((item) => item.kind)).toEqual(['agent'])
    expect(foldedCalls(fold.hidden).map((call) => call.name)).toEqual(['Read', 'Read', 'Edit'])
  })

  test('folds the calls that trail the answer into the same summary', () => {
    const rows = toTranscriptRows([
      toolCall('Bash'),
      toolCall('Bash'),
      toolCall('Bash'),
      toolCall('Read'),
      agentMessage('here is what I found'),
      toolCall('Bash'),
      toolCall('Bash'),
      toolCall('Read'),
      toolCall('Bash')
    ])
    const fold = foldTurn(rows)

    expect(fold.kept).toHaveLength(1)
    expect(tallyOf(foldedCalls(fold.hidden))).toEqual([
      { name: 'Bash', count: 6 },
      { name: 'Read', count: 2 }
    ])
  })

  test('keeps a call that did not settle', () => {
    const rows = toTranscriptRows([
      toolCall('Read'),
      toolCall('Bash', 'error'),
      agentMessage('that failed')
    ])
    const fold = foldTurn(rows)

    const keptNames = foldedCalls(fold.kept).map((call) => call.name)
    expect(keptNames).toEqual(['Bash'])
    expect(foldedCalls(fold.hidden).map((call) => call.name)).toEqual(['Read'])
  })

  test('keeps a notice out of the fold', () => {
    const rows = toTranscriptRows([toolCall('Read'), notice('rate limited'), agentMessage('ok')])
    const fold = foldTurn(rows)

    expect(fold.kept.some((row) => row.kind === 'item' && row.item.kind === 'notice')).toBe(true)
  })

  test('folds nothing while the turn has no answer yet', () => {
    const rows = toTranscriptRows([toolCall('Read'), toolCall('Read')])
    const fold = foldTurn(rows)

    expect(fold.hidden).toHaveLength(0)
    expect(fold.kept).toEqual(rows)
  })
})
