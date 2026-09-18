// What an issue's worktree branch gets called. The convention is written out by
// hand in CLAUDE.md, so the version the pane applies is pinned here rather than
// discovered from a directory listing after the fact.

import { describe, it, expect } from 'bun:test'
import { branchNameFor, slugify } from '../src/renderer/src/kernel/plugins/github/branches'

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
