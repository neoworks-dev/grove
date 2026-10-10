// Stepping among the items under the agent prompt skips what is disabled and stops at the ends.

import { describe, expect, test } from 'bun:test'
import { nextEnabledIndex } from '../src/renderer/src/lib/agents/footerFocus'

describe('nextEnabledIndex', () => {
  test('moves to the neighbour that can take focus', () => {
    expect(nextEnabledIndex([false, false, false], 0, 1)).toBe(1)
    expect(nextEnabledIndex([false, false, false], 2, -1)).toBe(1)
  })

  test('steps over a disabled item', () => {
    expect(nextEnabledIndex([false, true, false], 0, 1)).toBe(2)
  })

  test('stays put at either end', () => {
    expect(nextEnabledIndex([false, false], 1, 1)).toBeNull()
    expect(nextEnabledIndex([false, false], 0, -1)).toBeNull()
    expect(nextEnabledIndex([false, true], 0, 1)).toBeNull()
  })

  test('from before the first item it finds the first one that is enabled', () => {
    expect(nextEnabledIndex([true, false], -1, 1)).toBe(1)
  })
})
