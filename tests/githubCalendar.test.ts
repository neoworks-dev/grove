// The issue calendar lays a month out Monday first and places issues by one
// of the organisation's date fields. Days are `YYYY-MM-DD` strings throughout,
// so these pin the grid and the placing without a time zone in the way.

import { describe, expect, it } from 'bun:test'
import {
  addDays,
  calendarRange,
  clearedDates,
  daysBetween,
  isOverdue,
  monthGrid,
  movedDates,
  placeIssues,
  resizedDates,
  shiftMonth,
  spanOf,
  weekBars,
  withDateValue,
  type CalendarRange
} from '../src/renderer/src/kernel/plugins/github/calendar'
import type { GithubIssueItem } from '../src/shared/types'

const RANGE: CalendarRange = {
  start: { id: 'start', name: 'Start date' },
  end: { id: 'target', name: 'Target date' }
}
const SINGLE: CalendarRange = { start: { id: 'target', name: 'Target date' }, end: null }

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

describe('calendarRange', () => {
  it('pairs a start field with a target field, whatever was chosen', () => {
    const fields = [
      { id: 'target', name: 'Target date' },
      { id: 'start', name: 'Start date' }
    ]
    expect(calendarRange(fields, 'target')).toEqual(RANGE)
  })

  it('falls back to the chosen field alone without a pair', () => {
    const fields = [
      { id: 'a', name: 'Shipped' },
      { id: 'target', name: 'Target date' }
    ]
    expect(calendarRange(fields, 'target')).toEqual(SINGLE)
    expect(calendarRange(fields, null)?.start.id).toBe('a')
    expect(calendarRange([], null)).toBeNull()
  })
})

describe('spanOf', () => {
  it('covers start to target, or the one day that is set', () => {
    expect(spanOf(issue(1, { start: '2026-10-05', target: '2026-10-09' }), RANGE)).toMatchObject({
      start: '2026-10-05',
      end: '2026-10-09'
    })
    expect(spanOf(issue(1, { target: '2026-10-09' }), RANGE)).toMatchObject({
      start: '2026-10-09',
      end: '2026-10-09'
    })
    expect(spanOf(issue(1, { start: '2026-10-09', target: '2026-10-01' }), RANGE)).toMatchObject({
      start: '2026-10-09',
      end: '2026-10-09'
    })
    expect(spanOf(issue(1), RANGE)).toBeNull()
  })
})

describe('placeIssues', () => {
  it('spans the dated issues and sets the rest aside', () => {
    const placed = placeIssues(
      [issue(1, { target: '2026-10-20' }), issue(2), issue(3, { target: '2026-10-21' })],
      SINGLE
    )
    expect(placed.spans.map((span) => span.issue.number)).toEqual([1, 3])
    expect(placed.undated.map((entry) => entry.number)).toEqual([2])
  })
})

describe('weekBars', () => {
  // Monday 2026-10-05 to Sunday 2026-10-11.
  const week = monthGrid('2026-10')[1]

  it('cuts a bar to the week and stacks overlapping ones', () => {
    const spans = [
      spanOf(issue(1, { start: '2026-10-01', target: '2026-10-07' }), RANGE)!,
      spanOf(issue(2, { start: '2026-10-06', target: '2026-10-20' }), RANGE)!,
      spanOf(issue(3, { start: '2026-10-09' }), RANGE)!
    ]
    const bars = weekBars(spans, week)
    expect(
      bars.map((bar) => [bar.span.issue.number, bar.startColumn, bar.endColumn, bar.lane])
    ).toEqual([
      [1, 0, 2, 0],
      [2, 1, 6, 1],
      [3, 4, 4, 0]
    ])
    expect(bars[0]).toMatchObject({ startsHere: false, endsHere: true })
    expect(bars[1]).toMatchObject({ startsHere: true, endsHere: false })
  })

  it('leaves out bars outside the week', () => {
    const spans = [spanOf(issue(1, { start: '2026-10-20' }), RANGE)!]
    expect(weekBars(spans, week)).toEqual([])
  })
})

describe('movedDates', () => {
  it('keeps the length of a bar it moves', () => {
    const span = spanOf(issue(1, { start: '2026-10-05', target: '2026-10-07' }), RANGE)!
    expect(movedDates(span, RANGE, '2026-10-30')).toEqual({
      start: '2026-10-30',
      target: '2026-11-01'
    })
  })

  it('gives a single-day issue no target it did not have', () => {
    const span = spanOf(issue(1, { start: '2026-10-05' }), RANGE)!
    expect(movedDates(span, RANGE, '2026-10-12')).toEqual({ start: '2026-10-12' })
  })
})

describe('resizedDates', () => {
  const span = spanOf(issue(1, { start: '2026-10-05' }), RANGE)!

  it('stretches a single day out to a target', () => {
    expect(resizedDates(span, RANGE, 'end', '2026-10-09')).toEqual({
      start: '2026-10-05',
      target: '2026-10-09'
    })
  })

  it('stops an end dragged past the other on its day', () => {
    expect(resizedDates(span, RANGE, 'end', '2026-10-01')).toEqual({
      start: '2026-10-05',
      target: '2026-10-05'
    })
    expect(resizedDates(span, RANGE, 'start', '2026-10-09')).toEqual({
      start: '2026-10-05',
      target: '2026-10-05'
    })
  })
})

describe('clearedDates', () => {
  it('clears every field the calendar uses', () => {
    expect(clearedDates(RANGE)).toEqual({ start: null, target: null })
    expect(clearedDates(SINGLE)).toEqual({ target: null })
  })
})

describe('addDays', () => {
  it('crosses months and counts back', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3)
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
