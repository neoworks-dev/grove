import { describe, expect, test } from 'bun:test'
import {
  appendToQuery,
  currentHistoryMatch,
  historyMatches,
  isQueryCharacter,
  olderMatch,
  startHistorySearch,
  trimQuery
} from '../src/renderer/src/lib/agents/historySearch'

const HISTORY = ['fix the build', 'say hi', 'fix the tests', 'explain the build', 'fix the build']

describe('historyMatches', () => {
  test('finds prompts containing the query, newest first and each once', () => {
    expect(historyMatches(HISTORY, 'build')).toEqual(['fix the build', 'explain the build'])
  })

  test('ignores case', () => {
    expect(historyMatches(HISTORY, 'SAY')).toEqual(['say hi'])
  })

  test('an empty query matches nothing', () => {
    expect(historyMatches(HISTORY, '')).toEqual([])
  })
})

describe('searching', () => {
  test('typing narrows to the newest match, and backspace widens it again', () => {
    let search = startHistorySearch('draft')
    search = appendToQuery(search, 'f')
    search = appendToQuery(search, 'i')
    search = appendToQuery(search, 'x')
    expect(currentHistoryMatch(HISTORY, search)).toBe('fix the build')
    search = appendToQuery(search, 'z')
    expect(currentHistoryMatch(HISTORY, search)).toBeNull()
    search = trimQuery(search)
    expect(currentHistoryMatch(HISTORY, search)).toBe('fix the build')
  })

  test('stepping on goes to older matches and stops at the oldest', () => {
    let search = appendToQuery(startHistorySearch(''), 'fix')
    search = olderMatch(HISTORY, search)
    expect(currentHistoryMatch(HISTORY, search)).toBe('fix the tests')
    search = olderMatch(HISTORY, search)
    search = olderMatch(HISTORY, search)
    expect(currentHistoryMatch(HISTORY, search)).toBe('fix the tests')
  })

  test('typing again starts from the newest match', () => {
    let search = appendToQuery(startHistorySearch(''), 'fix')
    search = olderMatch(HISTORY, search)
    search = appendToQuery(search, ' ')
    expect(search.skipped).toBe(0)
  })

  test('the draft the search began with is kept', () => {
    const search = appendToQuery(startHistorySearch('half written'), 'a')
    expect(search.original).toBe('half written')
  })
})

describe('isQueryCharacter', () => {
  const plain = { ctrlKey: false, altKey: false, metaKey: false }

  test('accepts printable characters only', () => {
    expect(isQueryCharacter({ key: 'a', ...plain })).toBe(true)
    expect(isQueryCharacter({ key: ' ', ...plain })).toBe(true)
    expect(isQueryCharacter({ key: 'Enter', ...plain })).toBe(false)
    expect(isQueryCharacter({ key: 'a', ...plain, ctrlKey: true })).toBe(false)
  })
})
