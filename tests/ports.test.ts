import { describe, it, expect } from 'bun:test'
import { portsForSlot, nextFreeSlot, assignSlots } from '../src/main/ports'

const config = { start: 3100, countPerWorktree: 10 }

describe('portsForSlot', () => {
  it('allocates a contiguous block per slot', () => {
    expect(portsForSlot(config, 0)).toEqual([
      3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3109
    ])
    expect(portsForSlot(config, 1)[0]).toBe(3110)
    expect(portsForSlot(config, 2)[0]).toBe(3120)
  })

  it('is deterministic for a given slot', () => {
    expect(portsForSlot(config, 3)).toEqual(portsForSlot(config, 3))
  })
})

describe('nextFreeSlot', () => {
  it('returns the lowest unused slot', () => {
    expect(nextFreeSlot([])).toBe(0)
    expect(nextFreeSlot([0, 1, 2])).toBe(3)
    expect(nextFreeSlot([0, 2])).toBe(1)
  })
})

describe('assignSlots', () => {
  it('keeps existing assignments stable', () => {
    const existing = { a: 0, b: 2 }
    const result = assignSlots(existing, ['a', 'b'])
    expect(result).toEqual({ a: 0, b: 2 })
  })

  it('fills gaps for new worktrees deterministically', () => {
    const existing = { a: 0, b: 2 }
    const result = assignSlots(existing, ['a', 'b', 'c', 'd'])
    expect(result.a).toBe(0)
    expect(result.b).toBe(2)
    expect(result.c).toBe(1)
    expect(result.d).toBe(3)
  })

  it('assigns from zero when nothing exists', () => {
    const result = assignSlots({}, ['x', 'y'])
    expect(result).toEqual({ x: 0, y: 1 })
  })
})
