// Tap versus hold for the Space key. A tap must stay a plain space, and a press
// held past the threshold must start dictation exactly once.

import { describe, expect, test } from 'bun:test'
import { SpaceHold } from '../src/renderer/src/lib/voiceHold'

const HOLD_MS = 20

/** Waits for longer than the hold threshold, so a pending press has had time to become a hold. */
function pastHoldTime(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, HOLD_MS * 3))
}

describe('SpaceHold', () => {
  test('a tap released before the threshold never becomes a hold', async () => {
    let holds = 0
    const hold = new SpaceHold(() => (holds += 1), HOLD_MS)

    hold.press()
    const becameHold = hold.release()
    await pastHoldTime()

    expect(becameHold).toBe(false)
    expect(holds).toBe(0)
    expect(hold.isActive()).toBe(false)
  })

  test('a press still held after the threshold starts exactly one hold', async () => {
    let holds = 0
    const hold = new SpaceHold(() => (holds += 1), HOLD_MS)

    hold.press()
    await pastHoldTime()
    hold.press()
    await pastHoldTime()

    expect(holds).toBe(1)
    expect(hold.isActive()).toBe(true)
  })

  test('releasing a hold reports that it has to be finished', async () => {
    const hold = new SpaceHold(() => {}, HOLD_MS)

    hold.press()
    await pastHoldTime()

    expect(hold.release()).toBe(true)
    expect(hold.isActive()).toBe(false)
  })

  test('a pending press counts as active, so repeats of it can be dropped', () => {
    const hold = new SpaceHold(() => {}, HOLD_MS)

    hold.press()

    expect(hold.isActive()).toBe(true)
    hold.reset()
  })

  test('reset drops a pending press without starting a hold', async () => {
    let holds = 0
    const hold = new SpaceHold(() => (holds += 1), HOLD_MS)

    hold.press()
    hold.reset()
    await pastHoldTime()

    expect(holds).toBe(0)
    expect(hold.isActive()).toBe(false)
  })
})
