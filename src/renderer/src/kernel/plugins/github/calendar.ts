// The issue calendar: a month of days, weeks starting on Monday, with each
// issue a bar from its Start date to its Target date. Where the organisation
// has no such pair, issues sit on the one day of a single date field instead.
// Days are `YYYY-MM-DD` strings throughout, which is how GitHub stores them, so
// nothing here passes through a time zone.

import type { GithubIssueDateField, GithubIssueItem } from '../../../../../shared/types'

/** One cell of the month grid. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  date: string
  /** Day of the month, for the cell's corner. */
  dayOfMonth: number
  /** False for the days of the months before and after that fill out the first and last weeks. */
  inMonth: boolean
}

/** A month as `YYYY-MM`, the way the calendar keeps which one it shows. */
export type CalendarMonth = string

/** The weeks of a month, Monday first, padded with the neighbouring months' days. */
export function monthGrid(month: CalendarMonth): CalendarDay[][] {
  const [year, monthIndex] = parseMonth(month)
  const first = new Date(year, monthIndex, 1)
  // getDay counts from Sunday; the grid starts on Monday.
  const leading = (first.getDay() + 6) % 7
  const start = new Date(year, monthIndex, 1 - leading)
  const weeks: CalendarDay[][] = []
  const cursor = new Date(start)
  while (weeks.length === 0 || cursor.getMonth() === monthIndex) {
    const week: CalendarDay[] = []
    for (let weekday = 0; weekday < 7; weekday++) {
      week.push({
        date: dayString(cursor),
        dayOfMonth: cursor.getDate(),
        inMonth: cursor.getMonth() === monthIndex
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

/** The date fields the calendar places issues by: where a bar starts, and where it ends if anywhere. */
export interface CalendarRange {
  start: GithubIssueDateField
  /** Null when the organisation has no end field, and every issue is one day. */
  end: GithubIssueDateField | null
}

/**
 * The fields to place issues by. A start field and an end field (Target, End
 * or Due) together make bars; without both, the chosen field alone, or the
 * first, places each issue on one day.
 */
export function calendarRange(
  fields: GithubIssueDateField[],
  chosenId: string | null
): CalendarRange | null {
  const start = fields.find((field) => /start/i.test(field.name))
  const end = fields.find((field) => field !== start && /target|end|due/i.test(field.name))
  if (start && end) return { start, end }
  const chosen = fields.find((field) => field.id === chosenId)
  if (chosen) return { start: chosen, end: null }
  if (fields.length === 0) return null
  return { start: fields[0], end: null }
}

/** The days an issue covers, first and last inclusive; a single day has both the same. */
export interface IssueSpan {
  issue: GithubIssueItem
  start: string
  end: string
}

/**
 * The days an issue covers. With only one of its dates set it covers that day,
 * and an end before the start is read as the start alone. Null when neither is set.
 */
export function spanOf(issue: GithubIssueItem, range: CalendarRange): IssueSpan | null {
  let start = dateOf(issue, range.start.id)
  let end: string | null = null
  if (range.end) end = dateOf(issue, range.end.id)
  if (start === null) start = end
  if (start === null) return null
  if (end === null || end < start) end = start
  return { issue, start, end }
}

/** The spans of the issues that have one, and the issues without. */
export function placeIssues(
  issues: GithubIssueItem[],
  range: CalendarRange
): { spans: IssueSpan[]; undated: GithubIssueItem[] } {
  const spans: IssueSpan[] = []
  const undated: GithubIssueItem[] = []
  for (const issue of issues) {
    const span = spanOf(issue, range)
    if (span) {
      spans.push(span)
      continue
    }
    undated.push(issue)
  }
  return { spans, undated }
}

/** The piece of an issue's bar that falls in one week. */
export interface WeekBar {
  span: IssueSpan
  /** Weekday the piece starts and ends on, 0 for Monday. */
  startColumn: number
  endColumn: number
  /** Row under the day numbers, so bars that overlap stack instead of covering each other. */
  lane: number
  /** Whether the issue's first and last day are in this week, which is where the bar's ends round off. */
  startsHere: boolean
  endsHere: boolean
}

/**
 * The bars of a week: each span that reaches into it, cut to the week, and
 * stacked into the first lane free on all its days. Earlier and longer bars
 * take the upper lanes, so a bar keeps its lane across a week where it can.
 */
export function weekBars(spans: IssueSpan[], week: CalendarDay[]): WeekBar[] {
  const first = week[0].date
  const last = week[week.length - 1].date
  const inWeek = spans.filter((span) => span.start <= last && span.end >= first)
  inWeek.sort(compareSpans)
  // The last column taken in each lane so far.
  const laneEnds: number[] = []
  const bars: WeekBar[] = []
  for (const span of inWeek) {
    const startColumn = columnOf(week, laterOf(span.start, first))
    const endColumn = columnOf(week, earlierOf(span.end, last))
    let lane = laneEnds.findIndex((end) => end < startColumn)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(endColumn)
    } else {
      laneEnds[lane] = endColumn
    }
    bars.push({
      span,
      startColumn,
      endColumn,
      lane,
      startsHere: span.start >= first,
      endsHere: span.end <= last
    })
  }
  return bars
}

/** Orders spans by start, then the longer first, then by number so the order is stable. */
function compareSpans(left: IssueSpan, right: IssueSpan): number {
  if (left.start < right.start) return -1
  if (left.start > right.start) return 1
  if (left.end > right.end) return -1
  if (left.end < right.end) return 1
  return left.issue.number - right.issue.number
}

/** The weekday a day of the week falls on, 0 for Monday. */
function columnOf(week: CalendarDay[], date: string): number {
  return week.findIndex((day) => day.date === date)
}

function laterOf(left: string, right: string): string {
  if (left > right) return left
  return right
}

function earlierOf(left: string, right: string): string {
  if (left < right) return left
  return right
}

/**
 * The dates to write when a bar is dropped on a day: it starts there and keeps
 * its length. The end is only written where the issue has one, so moving a
 * single-day issue does not give it an end it never had.
 */
export function movedDates(
  span: IssueSpan,
  range: CalendarRange,
  day: string
): Record<string, string | null> {
  const dates: Record<string, string | null> = { [range.start.id]: day }
  if (!range.end) return dates
  if (dateOf(span.issue, range.end.id) === null) return dates
  dates[range.end.id] = addDays(day, daysBetween(span.start, span.end))
  return dates
}

/**
 * The dates to write when one end of a bar is dragged to a day. The other end
 * stays put, and an end dragged past it stops on its day. Both dates are
 * written, since stretching a single-day issue is what gives it its second one.
 */
export function resizedDates(
  span: IssueSpan,
  range: CalendarRange,
  edge: 'start' | 'end',
  day: string
): Record<string, string | null> {
  let start = span.start
  let end = span.end
  if (edge === 'start') start = earlierOf(day, end)
  if (edge === 'end') end = laterOf(day, start)
  const dates: Record<string, string | null> = { [range.start.id]: start }
  if (range.end) dates[range.end.id] = end
  return dates
}

/** The dates to write when an issue goes to "No date": every field the calendar uses, cleared. */
export function clearedDates(range: CalendarRange): Record<string, string | null> {
  const dates: Record<string, string | null> = { [range.start.id]: null }
  if (range.end) dates[range.end.id] = null
  return dates
}

/** The issue with each of the given date fields set, or cleared where the day is null. */
export function withDateValues(
  issue: GithubIssueItem,
  dates: Record<string, string | null>
): GithubIssueItem {
  let next = issue
  for (const [fieldId, date] of Object.entries(dates)) {
    next = withDateValue(next, fieldId, date)
  }
  return next
}

/** A day some number of days after another, or before it for a negative count. */
export function addDays(date: string, count: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + count)
  return moved.toISOString().slice(0, 10)
}

/** How many days the second day is after the first. */
export function daysBetween(from: string, to: string): number {
  const milliseconds = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(milliseconds / 86_400_000)
}

/** The day an issue's date field is set to, or null when it is not set. */
export function dateOf(issue: GithubIssueItem, fieldId: string): string | null {
  if (!issue.dateValues) return null
  const date = issue.dateValues[fieldId]
  if (date === undefined) return null
  return date
}

/** The issue with a date field set to a day, or cleared when the day is null. */
export function withDateValue(
  issue: GithubIssueItem,
  fieldId: string,
  date: string | null
): GithubIssueItem {
  const dateValues: Record<string, string> = { ...issue.dateValues }
  if (date === null) {
    delete dateValues[fieldId]
  } else {
    dateValues[fieldId] = date
  }
  return { ...issue, dateValues }
}

/** Whether an open issue's day has passed. Days compare as strings, being zero-padded. */
export function isOverdue(issue: GithubIssueItem, date: string, today: string): boolean {
  return issue.state === 'OPEN' && date < today
}

/** The month a number of months away from another. */
export function shiftMonth(month: CalendarMonth, by: number): CalendarMonth {
  const [year, monthIndex] = parseMonth(month)
  const shifted = new Date(year, monthIndex + by, 1)
  return dayString(shifted).slice(0, 7)
}

/** The month a day falls in. */
export function monthOf(date: Date): CalendarMonth {
  return dayString(date).slice(0, 7)
}

/** A month's name and year for the calendar's heading, in the user's locale. */
export function monthTitle(month: CalendarMonth): string {
  const [year, monthIndex] = parseMonth(month)
  return new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
}

/** A local date as `YYYY-MM-DD`. */
export function dayString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** A `YYYY-MM` month as its year and zero-based month index. */
function parseMonth(month: CalendarMonth): [number, number] {
  const [year, monthNumber] = month.split('-').map(Number)
  return [year, monthNumber - 1]
}
