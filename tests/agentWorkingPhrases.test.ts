// The lines the working bar rotates through while a turn is in flight.

import { describe, expect, test } from 'bun:test'
import { nextWorkingPhrase, WORKING_PHRASES } from '../src/renderer/src/lib/agents/workingPhrases'

describe('nextWorkingPhrase', () => {
  test('always answers with one of the phrases', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(WORKING_PHRASES).toContain(nextWorkingPhrase(''))
    }
  })

  test('never hands back the phrase already on screen', () => {
    const current = WORKING_PHRASES[0]
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(nextWorkingPhrase(current)).not.toBe(current)
    }
  })
})
