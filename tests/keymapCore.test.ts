import { describe, it, expect } from 'bun:test'
import { startsWith, pickNeighbor, type Rect } from '../src/renderer/src/lib/keymapCore'

describe('startsWith', () => {
  it('matches an exact prefix', () => {
    expect(startsWith(['w', 'h'], ['w'])).toBe(true)
    expect(startsWith(['w', 'h'], ['w', 'h'])).toBe(true)
  })
  it('rejects a non-prefix or an over-long prefix', () => {
    expect(startsWith(['w', 'h'], ['f'])).toBe(false)
    expect(startsWith(['w'], ['w', 'h'])).toBe(false)
  })
})

describe('pickNeighbor', () => {
  // Layout: sidebar | center | agent  (row), logs below center.
  const rect = (left: number, top: number): Rect => ({ left, top, width: 100, height: 100 })
  const center = rect(200, 0)
  const others = [
    { id: 'sidebar', rect: rect(0, 0) },
    { id: 'agent', rect: rect(400, 0) },
    { id: 'logs', rect: rect(200, 200) }
  ]

  it('moves left to the sidebar', () => {
    expect(pickNeighbor(center, others, 'h')).toBe('sidebar')
  })
  it('moves right to the agent', () => {
    expect(pickNeighbor(center, others, 'l')).toBe('agent')
  })
  it('moves down to the logs', () => {
    expect(pickNeighbor(center, others, 'j')).toBe('logs')
  })
  it('returns null when nothing lies that way', () => {
    expect(pickNeighbor(center, others, 'k')).toBeNull()
  })
})
