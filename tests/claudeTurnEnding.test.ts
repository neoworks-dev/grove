// How a Claude turn's result becomes the session's stop reason.
//
// Claude Code ends a turn it was interrupted in with `error_during_execution`.
// When the user asked for that — Stop, or a plain Deny — the turn was stopped,
// and saying it failed puts a red banner and a "failed" notification on a
// decision the user made (#224).

import { describe, expect, test } from 'bun:test'
import { turnEnding } from '../src/main/agents/harnesses/claude'

describe('turnEnding', () => {
  test('a finished turn ends normally', () => {
    expect(turnEnding('success', false)).toEqual({ stopReason: 'end_turn', error: null })
  })

  test('a turn the user stopped ends aborted, with nothing to report', () => {
    expect(turnEnding('error_during_execution', true)).toEqual({
      stopReason: 'aborted',
      error: null
    })
  })

  test('the same result without a stop is a failure', () => {
    expect(turnEnding('error_during_execution', false)).toEqual({
      stopReason: 'error',
      error: 'run ended: error_during_execution'
    })
  })

  test('a stop does not hide a different failure', () => {
    expect(turnEnding('error_max_turns', true)).toEqual({
      stopReason: 'error',
      error: 'run ended: error_max_turns'
    })
  })
})
