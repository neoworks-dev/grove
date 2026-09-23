// What an issue's worktree branch gets called. The convention is written out by
// hand in CLAUDE.md, so the version the pane applies is pinned here rather than
// discovered from a directory listing after the fact.

import { describe, it, expect } from 'bun:test'
import {
  branchNameFor,
  freeBranchName,
  isBranchForIssue,
  slugify
} from '../src/renderer/src/kernel/plugins/github/branches'

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('Tab strip overflow')).toBe('tab-strip-overflow')
  })

  it('drops punctuation rather than encoding it', () => {
    expect(slugify("The composer's label picker: bad")).toBe('the-composer-s-label-picker-bad')
  })

  it('cuts at a word boundary, not mid-word', () => {
    const slug = slugify('Projects, milestones and issue types are missing everywhere')
    expect(slug).toBe('projects-milestones-and-issue-types-are')
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('keeps a first word that is longer than the budget on its own', () => {
    expect(slugify('Supercalifragilisticexpialidociousandthensome now')).toBe(
      'supercalifragilisticexpialidociousandthen'.slice(0, 40)
    )
  })

  it('is empty when the title carries nothing a branch can use', () => {
    expect(slugify('!!! ??? …')).toBe('')
  })
})

describe('branchNameFor', () => {
  it('is the number and the slug, as the repository writes them', () => {
    expect(branchNameFor(12, 'Tab strip overflow')).toBe('12-tab-strip-overflow')
  })

  it('falls back to the number alone when there is no slug', () => {
    expect(branchNameFor(12, '???')).toBe('12')
  })
})

describe('isBranchForIssue', () => {
  it('matches the bare number and the number with a slug', () => {
    expect(isBranchForIssue('60', 60)).toBe(true)
    expect(isBranchForIssue('60-hand-an-issue-to-an-agent', 60)).toBe(true)
  })

  it('does not match a longer number that starts the same', () => {
    expect(isBranchForIssue('601-other', 60)).toBe(false)
    expect(isBranchForIssue('feature/60-x', 60)).toBe(false)
  })
})

describe('freeBranchName', () => {
  it('keeps the name when nothing has it', () => {
    expect(freeBranchName('60-x', ['main'])).toBe('60-x')
  })

  it('counts up past the names already taken', () => {
    expect(freeBranchName('60-x', ['60-x'])).toBe('60-x-2')
    expect(freeBranchName('60-x', ['60-x', '60-x-2'])).toBe('60-x-3')
  })
})
