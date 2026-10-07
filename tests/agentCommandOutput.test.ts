// When a command call keeps its output on screen: while it runs, and in the
// turn in flight after it finishes, so the transcript never shrinks under the
// reader; a settled turn lets it go.

import { describe, expect, test } from 'bun:test'
import { showsCommandOutput } from '../src/renderer/src/lib/agents/outputTail'

const finished = { callRunning: false, result: 'ok\n' }

describe('a command call’s output', () => {
  test('shows while the command runs, whatever turn it is in', () => {
    expect(
      showsCommandOutput({ callRunning: true, streamed: { running: true }, live: false, result: '' })
    ).toBe(true)
  })

  test('stays once it finishes, in the turn in flight', () => {
    expect(showsCommandOutput({ ...finished, streamed: { running: false }, live: true })).toBe(true)
  })

  test('shows the returned result in the turn in flight when nothing was streamed', () => {
    expect(showsCommandOutput({ ...finished, streamed: undefined, live: true })).toBe(true)
  })

  test('goes once the turn has settled', () => {
    expect(showsCommandOutput({ ...finished, streamed: { running: false }, live: false })).toBe(false)
    expect(showsCommandOutput({ ...finished, streamed: undefined, live: false })).toBe(false)
  })

  test('keeps showing a command sent to the background after its turn', () => {
    expect(showsCommandOutput({ ...finished, streamed: { running: true }, live: false })).toBe(true)
  })

  test('has nothing to show for a silent command that streamed nothing', () => {
    expect(showsCommandOutput({ callRunning: false, streamed: undefined, live: true, result: '' })).toBe(false)
  })
})
