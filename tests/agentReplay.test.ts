// The replay pane's scrubber: where it can stop, and how a step reads.

import { describe, expect, test } from 'bun:test'
import { lineTotals, positionsOf, promptHeadline, stepTitle } from '../src/renderer/src/lib/agents/replay'
import type { AgentEditStep, SessionReplay } from '../src/shared/agents'

function step(index: number, overrides: Partial<AgentEditStep> = {}): AgentEditStep {
  return {
    index,
    turnSeq: 1,
    seq: index,
    toolCallId: `c${index}`,
    title: `Edit file ${index}`,
    kind: 'edit',
    at: '',
    before: `before-${index}`,
    after: `after-${index}`,
    files: [],
    ...overrides
  }
}

function replayOf(turns: AgentEditStep[][]): SessionReplay {
  return {
    sessionId: 's',
    title: 'Session',
    workspaceRoot: '/repo',
    turns: turns.map((steps, position) => ({
      seq: position + 1,
      at: '',
      from: 'You',
      prompt: `prompt ${position + 1}`,
      steps
    }))
  }
}

describe('positionsOf', () => {
  test('starts before the first edit, then stops after every step in order', () => {
    const positions = positionsOf(replayOf([[step(1), step(2)], [], [step(3)]]))
    expect(positions.map((position) => [position.index, position.tree])).toEqual([
      [0, 'before-1'],
      [1, 'after-1'],
      [2, 'after-2'],
      [3, 'after-3']
    ])
    expect(positions[3].turn?.prompt).toBe('prompt 3')
  })

  test('has no stops for a session that made no edits', () => {
    expect(positionsOf(replayOf([[], []]))).toEqual([])
  })
})

describe('reading a step', () => {
  test('a step without a title reads as its kind', () => {
    expect(stepTitle(step(1, { title: '  ' }))).toBe('edit')
  })

  test('binary files do not count towards the line totals', () => {
    const totals = lineTotals([
      { path: 'a', status: 'modified', added: 3, removed: 1 },
      { path: 'b.png', status: 'added', added: -1, removed: -1 }
    ])
    expect(totals).toEqual({ added: 3, removed: 1 })
  })

  test('a prompt is cut to its first line', () => {
    expect(promptHeadline('fix the bug\nand more detail')).toBe('fix the bug')
    expect(promptHeadline('x'.repeat(10), 5)).toBe('xxxx…')
  })
})
