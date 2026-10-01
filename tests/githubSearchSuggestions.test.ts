import { describe, expect, test } from 'bun:test'
import {
  applySuggestion,
  milestoneProgress,
  milestoneStanding,
  suggestSearch,
  tokenAt,
  type SuggestionSources
} from '../src/renderer/src/kernel/plugins/github/searchSuggestions'
import type { GithubMilestoneDefinition } from '../src/shared/types'

/** A label definition with a colour and a description, as the repository lists it. */
function label(
  name: string,
  description = ''
): { name: string; color: string; description: string } {
  return { name, color: 'd73a4a', description }
}

const MILESTONE: GithubMilestoneDefinition = {
  number: 1,
  title: 'v1.0',
  state: 'OPEN',
  dueOn: '2026-10-10T07:00:00Z',
  description: 'First release',
  openIssues: 3,
  closedIssues: 1
}

const SOURCES: SuggestionSources = {
  labels: [
    label('bug', "Something isn't working"),
    label('ready for review'),
    label('area:editor'),
    label('already fixed')
  ],
  people: [
    { login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
    { login: 'moritz', avatarUrl: null }
  ],
  viewer: { login: 'moritz', avatarUrl: null },
  milestones: [MILESTONE],
  types: [{ name: 'Bug', color: 'RED' }],
  projects: ['Roadmap'],
  branches: [
    { name: '12-tab-strip', pull: { number: 12, title: 'Tab strip' } },
    { name: 'main', pull: null }
  ]
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

describe('what a suggestion carries beside its name', () => {
  test('a label brings its colour and description', () => {
    const [bug] = suggestSearch('label:bu', SOURCES, 6)
    expect(bug.detail).toEqual({ kind: 'label', label: label('bug', "Something isn't working") })
  })

  test('a person brings their avatar, and @me stands for the viewer', () => {
    const [me, octocat, moritz] = suggestSearch('author:', SOURCES, 6)
    expect(me.detail).toEqual({ kind: 'person', actor: SOURCES.viewer, isViewer: true })
    expect(octocat.detail).toEqual({
      kind: 'person',
      actor: { login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
      isViewer: false
    })
    expect(moritz.detail).toMatchObject({ kind: 'person', isViewer: true })
  })

  test('@me is offered before the viewer is known', () => {
    const [me] = suggestSearch('author:@', { ...SOURCES, viewer: null }, 6)
    expect(me.label).toBe('@me')
  })

  test('a key and a word say what they narrow to', () => {
    expect(suggestSearch('mil', SOURCES, 6)[0].detail).toEqual({
      kind: 'key',
      description: 'In the milestone'
    })
    expect(suggestSearch('is:dr', SOURCES, 6)[0].detail).toEqual({
      kind: 'word',
      description: 'Draft pull requests'
    })
  })

  test('a branch brings the pull it is the head of', () => {
    expect(suggestSearch('head:12', SOURCES, 6)[0].detail).toEqual({
      kind: 'branch',
      branch: { name: '12-tab-strip', pull: { number: 12, title: 'Tab strip' } }
    })
  })

  test('a milestone reads as closed, past due, or due on a day', () => {
    const now = new Date('2026-10-01T12:00:00')
    expect(milestoneStanding(MILESTONE, now)).toStartWith('Due ')
    expect(milestoneStanding({ ...MILESTONE, dueOn: '2026-09-01T07:00:00Z' }, now)).toBe('Past due')
    expect(milestoneStanding({ ...MILESTONE, state: 'CLOSED' }, now)).toBe('Closed')
    expect(milestoneStanding({ ...MILESTONE, dueOn: null }, now)).toBeNull()
    expect(milestoneProgress(MILESTONE)).toBe(25)
    expect(milestoneProgress({ ...MILESTONE, openIssues: 0, closedIssues: 0 })).toBe(0)
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
