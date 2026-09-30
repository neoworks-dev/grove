import { describe, it, expect } from 'bun:test'
import { nextHiddenTab, revealScrollLeft, tabOverflow } from '../src/renderer/src/lib/tabOverflow'

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

describe('revealScrollLeft', () => {
  const insets = { left: 30, right: 30 }

  it('brings a tab in on the left clear of the counter', () => {
    // View 150–350: tab 1 (104–204) is cut off on the left.
    expect(revealScrollLeft(spans[1], 150, 350, insets)).toBe(74)
  })

  it('brings a tab in on the right clear of the counter', () => {
    // Tab 3 (312–412) ends past 350; its end lands 30px short of the view's.
    expect(revealScrollLeft(spans[3], 150, 350, insets)).toBe(242)
  })

  it('moves a tab out from under a counter even though it is inside the view', () => {
    // View 104–304: tab 1 starts flush with the edge, under the left counter.
    expect(revealScrollLeft(spans[1], 104, 304, insets)).toBe(74)
  })

  it('leaves the view where it is when the tab already shows', () => {
    expect(revealScrollLeft(spans[2], 150, 350, insets)).toBe(150)
  })
})
