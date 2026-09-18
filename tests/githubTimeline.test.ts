// GitHub emits one event per label, so a single edit that applies three labels
// arrives as three identical-looking rows. The fold is what turns those back
// into the one line the website shows.

import { describe, it, expect } from 'bun:test'
import { foldTimeline, associationLabel } from '../src/renderer/src/kernel/plugins/github/timeline'
import type { GithubActor, GithubTimelineEntry } from '../src/shared/types'

const MOE: GithubActor = { login: 'Letsmoe', avatarUrl: 'https://avatars.example/moe' }
const OTHER: GithubActor = { login: 'someone', avatarUrl: null }

function labelled(
  id: string,
  name: string,
  at: string,
  kind: 'labeled' | 'unlabeled' = 'labeled',
  actor = MOE
): GithubTimelineEntry {
  return {
    type: 'event',
    at,
    event: { id, kind, actor, createdAt: at, label: { name, color: 'ededed' } }
  }
}

function commented(id: string, at: string): GithubTimelineEntry {
  return {
    type: 'comment',
    at,
    comment: {
      id,
      author: MOE,
      body: 'hi',
      createdAt: at,
      url: '',
      authorAssociation: 'OWNER'
    }
  }
}

describe('foldTimeline', () => {
  it('folds one edit that applied several labels into a single row', () => {
    const rows = foldTimeline([
      labelled('1', 'enhancement', '2026-09-18T10:00:00Z'),
      labelled('2', 'area:git', '2026-09-18T10:00:01Z')
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('labels')
    if (rows[0].kind !== 'labels') throw new Error('expected a labels row')
    expect(rows[0].added.map((label) => label.name)).toEqual(['enhancement', 'area:git'])
    expect(rows[0].removed).toEqual([])
  })

  it('keeps additions and removals of one edit apart inside the row', () => {
    const rows = foldTimeline([
      labelled('1', 'bug', '2026-09-18T10:00:00Z'),
      labelled('2', 'enhancement', '2026-09-18T10:00:01Z', 'unlabeled')
    ])
    expect(rows).toHaveLength(1)
    if (rows[0].kind !== 'labels') throw new Error('expected a labels row')
    expect(rows[0].added.map((label) => label.name)).toEqual(['bug'])
    expect(rows[0].removed.map((label) => label.name)).toEqual(['enhancement'])
  })

  it('does not fold label changes made much later', () => {
    const rows = foldTimeline([
      labelled('1', 'bug', '2026-09-18T10:00:00Z'),
      labelled('2', 'area:ui', '2026-09-19T10:00:00Z')
    ])
    expect(rows).toHaveLength(2)
  })

  it('does not fold label changes made by different people', () => {
    const rows = foldTimeline([
      labelled('1', 'bug', '2026-09-18T10:00:00Z'),
      labelled('2', 'area:ui', '2026-09-18T10:00:01Z', 'labeled', OTHER)
    ])
    expect(rows).toHaveLength(2)
  })

  it('does not fold across something that happened in between', () => {
    const rows = foldTimeline([
      labelled('1', 'bug', '2026-09-18T10:00:00Z'),
      commented('c1', '2026-09-18T10:00:01Z'),
      labelled('2', 'area:ui', '2026-09-18T10:00:02Z')
    ])
    expect(rows.map((row) => row.kind)).toEqual(['labels', 'comment', 'labels'])
  })

  it('lists a label once even when GitHub repeats the event', () => {
    const rows = foldTimeline([
      labelled('1', 'bug', '2026-09-18T10:00:00Z'),
      labelled('2', 'bug', '2026-09-18T10:00:01Z')
    ])
    if (rows[0].kind !== 'labels') throw new Error('expected a labels row')
    expect(rows[0].added.map((label) => label.name)).toEqual(['bug'])
  })

  it('passes comments and other events through untouched', () => {
    const closed: GithubTimelineEntry = {
      type: 'event',
      at: '2026-09-18T11:00:00Z',
      event: { id: 'e1', kind: 'closed', actor: MOE, createdAt: '2026-09-18T11:00:00Z' }
    }
    const rows = foldTimeline([commented('c1', '2026-09-18T10:00:00Z'), closed])
    expect(rows.map((row) => row.kind)).toEqual(['comment', 'event'])
  })

  it('drops a label event that carries no label', () => {
    const broken: GithubTimelineEntry = {
      type: 'event',
      at: '2026-09-18T10:00:00Z',
      event: { id: 'e1', kind: 'labeled', actor: MOE, createdAt: '2026-09-18T10:00:00Z' }
    }
    expect(foldTimeline([broken])).toEqual([])
  })

  it('returns nothing for an empty thread', () => {
    expect(foldTimeline([])).toEqual([])
  })
})

describe('associationLabel', () => {
  it('names the relationships GitHub badges', () => {
    expect(associationLabel('OWNER')).toBe('Owner')
    expect(associationLabel('MEMBER')).toBe('Member')
    expect(associationLabel('CONTRIBUTOR')).toBe('Contributor')
  })

  it('says nothing for a stranger', () => {
    expect(associationLabel('NONE')).toBeNull()
  })
})
