// The issue calendar lays a month out Monday first and places issues by one
// of the organisation's date fields. Days are `YYYY-MM-DD` strings throughout,
// so these pin the grid and the placing without a time zone in the way.

import { describe, expect, it } from 'bun:test'
import {
  isOverdue,
  monthGrid,
  placeIssues,
  shiftMonth,
  withDateValue
} from '../src/renderer/src/kernel/plugins/github/calendar'
import type { GithubIssueItem } from '../src/shared/types'

/** An issue with the given state and date values. */
function issue(
  number: number,
  dateValues?: Record<string, string>,
  state = 'OPEN'
): GithubIssueItem {
  return {
    kind: 'issue',
    number,
    title: `Issue ${number}`,
    url: '',
    state,
    author: 'someone',
    createdAt: '',
    updatedAt: '',
    labels: [],
    assignees: [],
    commentCount: 0,
    dateValues
  }
}

describe('monthGrid', () => {
  it('starts on the Monday on or before the first and ends on the Sunday on or after the last', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const weeks = monthGrid('2026-10')
    expect(weeks[0][0].date).toBe('2026-09-28')
    expect(weeks[0][3]).toEqual({ date: '2026-10-01', dayOfMonth: 1, inMonth: true })
    expect(weeks[weeks.length - 1][6].date).toBe('2026-11-01')
    expect(weeks).toHaveLength(5)
  })

  it('keeps every week seven days long', () => {
    for (const week of monthGrid('2027-02')) expect(week).toHaveLength(7)
  })
})

describe('placeIssues', () => {
  it('puts issues on their day and the rest aside', () => {
    const placed = placeIssues(
      [issue(1, { target: '2026-10-20' }), issue(2), issue(3, { target: '2026-10-20' })],
      'target'
    )
    expect(placed.byDay.get('2026-10-20')?.map((entry) => entry.number)).toEqual([1, 3])
    expect(placed.undated.map((entry) => entry.number)).toEqual([2])
  })
})

describe('withDateValue', () => {
  it('sets and clears a date without touching the original', () => {
    const original = issue(1, { start: '2026-10-01' })
    const moved = withDateValue(original, 'target', '2026-10-31')
    expect(moved.dateValues).toEqual({ start: '2026-10-01', target: '2026-10-31' })
    expect(withDateValue(moved, 'target', null).dateValues).toEqual({ start: '2026-10-01' })
    expect(original.dateValues).toEqual({ start: '2026-10-01' })
  })
})

describe('isOverdue', () => {
  it('marks an open issue whose day has passed, and nothing closed', () => {
    expect(isOverdue(issue(1), '2026-10-01', '2026-10-08')).toBe(true)
    expect(isOverdue(issue(1), '2026-10-08', '2026-10-08')).toBe(false)
    expect(isOverdue(issue(1, undefined, 'CLOSED'), '2026-10-01', '2026-10-08')).toBe(false)
  })
})

describe('shiftMonth', () => {
  it('crosses year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })
})
