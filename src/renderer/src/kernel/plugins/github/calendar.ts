// The issue calendar: a month of days, weeks starting on Monday, with each open
// issue on the day one of the organisation's date fields (Target date, say)
// is set to. Days are `YYYY-MM-DD` strings throughout, which is how GitHub
// stores them, so nothing here passes through a time zone.

import type { GithubIssueItem } from '../../../../../shared/types'

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

/** The issues on each day for a date field, and the ones the field is not set on. */
export function placeIssues(
  issues: GithubIssueItem[],
  fieldId: string
): { byDay: Map<string, GithubIssueItem[]>; undated: GithubIssueItem[] } {
  const byDay = new Map<string, GithubIssueItem[]>()
  const undated: GithubIssueItem[] = []
  for (const issue of issues) {
    const date = dateOf(issue, fieldId)
    if (date === null) {
      undated.push(issue)
      continue
    }
    const day = byDay.get(date)
    if (day) {
      day.push(issue)
      continue
    }
    byDay.set(date, [issue])
  }
  return { byDay, undated }
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
