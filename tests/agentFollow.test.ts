// Follow mode opens each file the agent works on as its call comes in — even
// when the harness streams the call's arguments after the call itself.

import { describe, expect, test } from 'bun:test'
import { followStep } from '../src/renderer/src/lib/agents/follow'
import type { ToolItem } from '../src/renderer/src/lib/agents/transcript'

function call(id: string, status: ToolItem['status'], path?: string): ToolItem {
  return {
    kind: 'tool',
    seq: 1,
    eventId: `evt_${id}`,
    toolUseId: id,
    name: 'read',
    input: path ? { path } : {},
    editedInput: undefined,
    permission: 'allow',
    status,
    progress: '',
    result: '',
    images: []
  }
}

const pathOf = (item: ToolItem): string | null => {
  const input = item.input as { path?: string }
  return input.path ?? null
}

describe('follow mode', () => {
  test('opens a call’s file once its arguments arrive, not when the call first shows', () => {
    const first = followStep([call('t1', 'running')], new Set(), pathOf)
    expect(first.open).toEqual([])

    const second = followStep([call('t1', 'running', 'src/app.ts')], first.followed, pathOf)
    expect(second.open).toEqual(['src/app.ts'])

    const third = followStep([call('t1', 'ok', 'src/app.ts')], second.followed, pathOf)
    expect(third.open).toEqual([])
  })

  test('is done with a call that settled without a file', () => {
    const step = followStep([call('t1', 'ok')], new Set(), pathOf)
    expect(step.open).toEqual([])
    expect(step.followed.has('t1')).toBe(true)
  })

  test('leaves calls it already followed alone', () => {
    const step = followStep([call('t1', 'ok', 'a.ts'), call('t2', 'running', 'b.ts')], new Set(['t1']), pathOf)
    expect(step.open).toEqual(['b.ts'])
  })
})
