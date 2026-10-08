// The issue board: the open issues laid out in columns by one of the
// organisation's single-select issue fields, one column per option. An issue
// with no value for the field sits in the first column, the way Linear and
// GitHub Projects put "No Status" first.

import type { GithubIssueField, GithubIssueItem } from '../../../../../shared/types'

/** One column of the board: an option of the field, or none of them. */
export interface BoardColumn {
  /** Null for the column of issues the field is not set on. */
  optionId: string | null
  name: string
  /** GitHub's colour name for the option; null for the unset column. */
  color: string | null
  issues: GithubIssueItem[]
}

/** The board's columns for a field, each holding the issues set to its option, in list order. */
export function boardColumns(issues: GithubIssueItem[], field: GithubIssueField): BoardColumn[] {
  const unset: BoardColumn = { optionId: null, name: `No ${field.name}`, color: null, issues: [] }
  const columns: BoardColumn[] = [unset]
  for (const option of field.options) {
    columns.push({ optionId: option.id, name: option.name, color: option.color, issues: [] })
  }
  for (const issue of issues) {
    columnFor(columns, optionOf(issue, field.id)).issues.push(issue)
  }
  return columns
}

/** The option an issue is set to for a field, or null when it has none. */
export function optionOf(issue: GithubIssueItem, fieldId: string): string | null {
  if (!issue.fieldValues) return null
  const optionId = issue.fieldValues[fieldId]
  if (optionId === undefined) return null
  return optionId
}

/**
 * The column an option belongs in. An option the field no longer lists, which
 * happens when the organisation removes one, falls back to the unset column.
 */
function columnFor(columns: BoardColumn[], optionId: string | null): BoardColumn {
  const match = columns.find((column) => column.optionId === optionId)
  if (match) return match
  return columns[0]
}

/** The issue with one field set to an option, or cleared when the option is null. */
export function withFieldValue(
  issue: GithubIssueItem,
  fieldId: string,
  optionId: string | null
): GithubIssueItem {
  const fieldValues: Record<string, string> = { ...issue.fieldValues }
  if (optionId === null) {
    delete fieldValues[fieldId]
  } else {
    fieldValues[fieldId] = optionId
  }
  return { ...issue, fieldValues }
}

/** The field to group by: the chosen one while it still exists, else the first there is. */
export function resolveBoardField(
  fields: GithubIssueField[],
  chosenId: string | null
): GithubIssueField | null {
  const chosen = fields.find((field) => field.id === chosenId)
  if (chosen) return chosen
  if (fields.length === 0) return null
  return fields[0]
}

// GitHub names an option's colour rather than giving it; these are its own
// shades for those names, so a column's dot matches what github.com shows.
const OPTION_COLOURS: Record<string, string> = {
  GRAY: '#9198a1',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#ab7df8'
}

/** The CSS colour for an option's colour name; grey for a name GitHub adds later. */
export function optionColour(color: string | null): string {
  if (color === null) return OPTION_COLOURS.GRAY
  const colour = OPTION_COLOURS[color]
  if (colour === undefined) return OPTION_COLOURS.GRAY
  return colour
}
