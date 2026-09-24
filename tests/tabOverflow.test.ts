import { describe, it, expect } from 'bun:test'
import { nextHiddenTab, tabOverflow } from '../src/renderer/src/lib/tabOverflow'

// Five 100px tabs with 4px gaps: 0–100, 104–204, 208–308, 312–412, 416–516.
const spans = [0, 104, 208, 312, 416].map((start) => ({ start, end: start + 100 }))

describe('tabOverflow', () => {
  it('counts nothing when every tab fits', () => {
    expect(tabOverflow(spans, 0, 600)).toEqual({ left: 0, right: 0 })
  })

  it('counts a partly visible tab as out of view', () => {
    // View 150–350: tabs 0 and 1 start before it, 3 and 4 end after it.
    expect(tabOverflow(spans, 150, 350)).toEqual({ left: 2, right: 2 })
  })

  it('ignores a tab flush with the edge by a sub-pixel', () => {
    expect(tabOverflow(spans, 0, 516.5)).toEqual({ left: 0, right: 0 })
  })
})

describe('nextHiddenTab', () => {
  it('picks the hidden tab nearest the view on each side', () => {
    expect(nextHiddenTab(spans, 150, 350, 'left')).toBe(1)
    expect(nextHiddenTab(spans, 150, 350, 'right')).toBe(3)
  })

  it('has nothing to reveal on a side that is fully in view', () => {
    expect(nextHiddenTab(spans, 0, 350, 'left')).toBe(-1)
    expect(nextHiddenTab(spans, 0, 600, 'right')).toBe(-1)
  })
})
