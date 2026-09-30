import { describe, expect, test } from 'bun:test'
import {
  applySuggestion,
  suggestSearch,
  tokenAt,
  type SuggestionSources
} from '../src/renderer/src/kernel/plugins/github/searchSuggestions'

const SOURCES: SuggestionSources = {
  labels: ['bug', 'ready for review', 'area:editor', 'already fixed'],
  people: ['octocat', 'moritz'],
  milestones: ['v1.0'],
  types: ['Bug'],
  projects: ['Roadmap'],
  branches: ['main', '12-tab-strip']
}

/** The labels of what the box would offer for `token`. */
function offered(token: string): string[] {
  return suggestSearch(token, SOURCES, 6).map((suggestion) => suggestion.label)
}

describe('the token under the caret', () => {
  test('is the word the caret is in or at the end of', () => {
    expect(tokenAt('is:open label:rea', 17)).toEqual({ start: 8, end: 17, text: 'label:rea' })
    expect(tokenAt('is:open label:rea', 3).text).toBe('is:open')
  })

  test('keeps a quoted value with spaces together', () => {
    expect(tokenAt('label:"ready fo', 15).text).toBe('label:"ready fo')
  })

  test('is empty between two words', () => {
    expect(tokenAt('is:open  bug', 8)).toEqual({ start: 8, end: 8, text: '' })
  })
})

describe('suggestions', () => {
  test('a bare word offers the qualifiers it starts', () => {
    expect(offered('la')).toEqual(['label:'])
    expect(offered('a')).toEqual(['author:', 'assignee:'])
    expect(offered('-mi')).toEqual(['-milestone:'])
  })

  test('an empty token or plain text offers nothing', () => {
    expect(offered('')).toEqual([])
    expect(offered('crash')).toEqual([])
  })

  test('a label value offers the repository labels, prefix matches first', () => {
    expect(offered('label:rea')).toEqual(['ready for review', 'area:editor', 'already fixed'])
  })

  test('people come with @me', () => {
    expect(offered('author:')).toEqual(['@me', 'octocat', 'moritz'])
    expect(offered('assignee:oc')).toEqual(['octocat'])
  })

  test('is: and no: offer the words the search understands', () => {
    expect(offered('is:')).toEqual(['open', 'closed', 'merged', 'draft', 'pr', 'issue'])
    expect(offered('no:a')).toEqual(['assignee', 'label'])
  })

  test('a value already written in full is not offered again', () => {
    expect(offered('is:open')).toEqual([])
  })

  test('an unknown key offers nothing', () => {
    expect(offered('banana:x')).toEqual([])
  })

  test('values with spaces are inserted quoted, and a negation is kept', () => {
    const [ready] = suggestSearch('-label:rea', SOURCES, 6)
    expect(ready.insert).toBe('-label:"ready for review"')
  })
})

describe('accepting a suggestion', () => {
  test('a value replaces the token and moves past a trailing space', () => {
    const query = 'is:open label:rea'
    const token = tokenAt(query, query.length)
    const [ready] = suggestSearch(token.text, SOURCES, 6)
    expect(applySuggestion(query, token, ready)).toEqual({
      text: 'is:open label:"ready for review" ',
      caret: 33
    })
  })

  test('a key leaves the caret after its colon', () => {
    const query = 'is:open la bug'
    const token = tokenAt(query, 10)
    const [label] = suggestSearch(token.text, SOURCES, 6)
    expect(applySuggestion(query, token, label)).toEqual({ text: 'is:open label: bug', caret: 14 })
  })

  test('a value in the middle keeps one space before the rest', () => {
    const query = 'author:oc is:open'
    const token = tokenAt(query, 9)
    const [octocat] = suggestSearch(token.text, SOURCES, 6)
    expect(applySuggestion(query, token, octocat).text).toBe('author:octocat is:open')
  })
})
