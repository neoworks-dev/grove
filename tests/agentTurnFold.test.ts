// Folding a finished turn down to its answer. What hides is the work; what stays
// is the last thing the agent said, plus anything that still wants the user.

import { describe, expect, test } from 'bun:test'
import { tallyOf, toTranscriptRows } from '../src/renderer/src/lib/agents/toolRuns'
import { foldedCalls, foldedMessages, foldTurn } from '../src/renderer/src/lib/agents/turns'
import type { ToolItem, ToolStatus, TranscriptItem } from '../src/renderer/src/lib/agents/transcript'

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
    images: [],
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

  test('keeps a call that stands alone on screen', () => {
    const isEdit = (call: ToolItem): boolean => call.name === 'Edit'
    const rows = toTranscriptRows(
      [toolCall('Read'), toolCall('Edit'), toolCall('Read'), agentMessage('done')],
      isEdit
    )
    const fold = foldTurn(rows, isEdit)

    expect(foldedCalls(fold.hidden).map((call) => call.name)).toEqual(['Read', 'Read'])
    expect(fold.kept.map((row) => (row.kind === 'item' ? row.item.kind : row.kind))).toEqual([
      'tool',
      'agent'
    ])
  })

  test('keeps an answer split around a call that is part of it, in full', () => {
    const isLocations = (call: ToolItem): boolean => call.name === 'show_locations'
    const rows = toTranscriptRows([
      agentMessage('let me look'),
      toolCall('Read'),
      agentMessage('found it: the first half'),
      toolCall('show_locations'),
      agentMessage('and the second half')
    ])
    const fold = foldTurn(rows, () => false, isLocations)

    const keptText = fold.kept.map((row) => (row.kind === 'item' && row.item.kind === 'agent' ? row.item.text : ''))
    expect(keptText).toEqual(['found it: the first half', 'and the second half'])
    expect(foldedMessages(fold.hidden).map((item) => item.kind === 'agent' && item.text)).toEqual(['let me look'])
  })

  test('stops the answer at the last real work before it', () => {
    const isLocations = (call: ToolItem): boolean => call.name === 'show_locations'
    const rows = toTranscriptRows([
      agentMessage('interim note'),
      toolCall('Read'),
      agentMessage('the answer')
    ])
    const fold = foldTurn(rows, () => false, isLocations)

    expect(fold.kept).toHaveLength(1)
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
      { name: 'Bash', count: 6, files: [] },
      { name: 'Read', count: 2, files: [] }
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

describe('a group of calls in a finished turn', () => {
  const browserGroup = (call: ToolItem): string | null => (call.name === 'browser' ? 'browser' : null)
  const hasImages = (call: ToolItem): boolean => call.images.length > 0

  test('folds away when every call went well', () => {
    const rows = toTranscriptRows(
      [toolCall('browser'), toolCall('browser'), agentMessage('it works')],
      hasImages,
      browserGroup
    )
    const fold = foldTurn(rows, hasImages)
    expect(fold.kept.map((row) => row.kind)).toEqual(['item'])
    expect(fold.hidden.map((row) => row.kind)).toEqual(['callGroup'])
    expect(foldedCalls(fold.hidden)).toHaveLength(2)
  })

  test('stays on screen when a call failed or returned a picture', () => {
    const screenshot = toolCall('browser') as ToolItem
    screenshot.images = [{ ref: 'r1', mimeType: 'image/png' }] as ToolItem['images']
    const failed = toTranscriptRows(
      [toolCall('browser'), toolCall('browser', 'error'), agentMessage('broken')],
      hasImages,
      browserGroup
    )
    const pictured = toTranscriptRows([toolCall('browser'), screenshot, agentMessage('looks right')], hasImages, browserGroup)
    expect(foldTurn(failed, hasImages).kept.map((row) => row.kind)).toEqual(['callGroup', 'item'])
    expect(foldTurn(pictured, hasImages).kept.map((row) => row.kind)).toEqual(['callGroup', 'item'])
  })
})
