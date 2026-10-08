// The issue board lays the open issues out by one of the organisation's
// single-select issue fields. Which column an issue lands in, and what a drop
// changes, are pinned here.

import { describe, expect, it } from 'bun:test'
import {
  boardColumns,
  optionColour,
  optionOf,
  resolveBoardField,
  withFieldValue
} from '../src/renderer/src/kernel/plugins/github/board'
import {
  createView,
  viewMatches,
  type ViewState
} from '../src/renderer/src/kernel/plugins/github/views'
import type { GithubIssueField, GithubIssueItem } from '../src/shared/types'

const PRIORITY: GithubIssueField = {
  id: 'priority',
  name: 'Priority',
  options: [
    { id: 'high', name: 'High', color: 'RED' },
    { id: 'low', name: 'Low', color: 'GREEN' }
  ]
}

const EFFORT: GithubIssueField = { id: 'effort', name: 'Effort', options: [] }

/** An open issue with the given field values. */
function issue(number: number, fieldValues?: Record<string, string>): GithubIssueItem {
  return {
    kind: 'issue',
    number,
    title: `Issue ${number}`,
    url: '',
    state: 'OPEN',
    author: 'someone',
    createdAt: '',
    updatedAt: '',
    labels: [],
    assignees: [],
    commentCount: 0,
    id: `I_${number}`,
    fieldValues
  }
}

describe('boardColumns', () => {
  it("puts the unset column first, then one per option in the field's order", () => {
    const columns = boardColumns([], PRIORITY)
    expect(columns.map((column) => column.name)).toEqual(['No Priority', 'High', 'Low'])
    expect(columns[0].optionId).toBeNull()
  })

  it('places each issue under its option and keeps the list order inside a column', () => {
    const columns = boardColumns(
      [
        issue(1, { priority: 'low' }),
        issue(2),
        issue(3, { priority: 'low' }),
        issue(4, { effort: 'x' })
      ],
      PRIORITY
    )
    const numbers = columns.map((column) => column.issues.map((entry) => entry.number))
    expect(numbers).toEqual([[2, 4], [], [1, 3]])
  })

  it('puts an issue whose option the field no longer has in the unset column', () => {
    const columns = boardColumns([issue(1, { priority: 'removed' })], PRIORITY)
    expect(columns[0].issues.map((entry) => entry.number)).toEqual([1])
  })
})

describe('withFieldValue', () => {
  it('sets the field without touching the others or the original', () => {
    const original = issue(1, { effort: 'small' })
    const moved = withFieldValue(original, 'priority', 'high')
    expect(moved.fieldValues).toEqual({ effort: 'small', priority: 'high' })
    expect(original.fieldValues).toEqual({ effort: 'small' })
  })

  it('clears the field when moved to the unset column', () => {
    const moved = withFieldValue(issue(1, { priority: 'high' }), 'priority', null)
    expect(optionOf(moved, 'priority')).toBeNull()
  })
})

describe('resolveBoardField', () => {
  it('keeps the chosen field while it exists, and falls back to the first', () => {
    expect(resolveBoardField([PRIORITY, EFFORT], 'effort')).toBe(EFFORT)
    expect(resolveBoardField([PRIORITY, EFFORT], 'gone')).toBe(PRIORITY)
    expect(resolveBoardField([PRIORITY, EFFORT], null)).toBe(PRIORITY)
    expect(resolveBoardField([], null)).toBeNull()
  })
})

describe('optionColour', () => {
  it("maps GitHub's colour names, and anything else to grey", () => {
    expect(optionColour('RED')).toBe('#f85149')
    expect(optionColour(null)).toBe(optionColour('GRAY'))
    expect(optionColour('TEAL')).toBe(optionColour('GRAY'))
  })
})

describe('viewMatches', () => {
  const board: ViewState = { query: 'is:open label:bug', layout: 'board', fieldId: 'priority' }

  it('matches the same query, layout and field, whatever the spacing', () => {
    expect(viewMatches(board, { ...board, query: '  is:open   label:bug ' })).toBe(true)
  })

  it('tells views apart by query, layout or field', () => {
    expect(viewMatches(board, { ...board, query: 'is:open' })).toBe(false)
    expect(viewMatches(board, { ...board, layout: 'list' })).toBe(false)
    expect(viewMatches(board, { ...board, fieldId: 'effort' })).toBe(false)
  })
})

describe('createView', () => {
  it('trims the name and gives each view its own id', () => {
    const first = createView('  Urgent bugs ', board())
    const second = createView('Urgent bugs', board())
    expect(first.name).toBe('Urgent bugs')
    expect(first.id).not.toBe(second.id)
  })

  /** A board view to save. */
  function board(): ViewState {
    return { query: 'is:open', layout: 'board', fieldId: 'priority' }
  }
})
