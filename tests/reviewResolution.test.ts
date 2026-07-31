import { describe, it, expect } from 'bun:test'
import { describeResolution } from '../src/main/review'
import type { ReviewBatch } from '../src/shared/types'

function batchWith(relPath: string, hunkCount: number): ReviewBatch {
  return {
    id: 'b1',
    worktreeId: '/wt',
    agent: 'claude',
    chatId: 'chat1',
    origin: 'agent',
    files: [
      {
        relPath,
        baseline: '',
        current: '',
        hunks: Array.from({ length: hunkCount }, (_unused, index) => ({
          beforeStart: index + 1,
          removed: [],
          afterStart: index + 1,
          added: ['x']
        }))
      }
    ]
  }
}

describe('describeResolution', () => {
  it('says nothing when everything was accepted without comment', () => {
    const batch = batchWith('a.ts', 2)
    const text = describeResolution(batch, {
      batchId: 'b1',
      decisions: [
        { relPath: 'a.ts', hunkIndex: 0, accepted: true },
        { relPath: 'a.ts', hunkIndex: 1, accepted: true }
      ]
    })
    // Reporting a clean review would cost the agent a whole turn to read "fine".
    expect(text).toBeNull()
  })

  it('reports rejected hunks in 1-based numbering', () => {
    const batch = batchWith('a.ts', 3)
    const text = describeResolution(batch, {
      batchId: 'b1',
      decisions: [
        { relPath: 'a.ts', hunkIndex: 0, accepted: true },
        { relPath: 'a.ts', hunkIndex: 2, accepted: false }
      ]
    })
    expect(text).toContain('a.ts:')
    expect(text).toContain('hunk(s) 3')
  })

  it('reports a comment on a hunk that was nonetheless kept', () => {
    const batch = batchWith('a.ts', 1)
    const text = describeResolution(batch, {
      batchId: 'b1',
      decisions: [{ relPath: 'a.ts', hunkIndex: 0, accepted: true, comment: 'too verbose' }]
    })
    expect(text).toContain('(kept)')
    expect(text).toContain('too verbose')
  })

  it('marks a commented rejection as reverted', () => {
    const batch = batchWith('a.ts', 1)
    const text = describeResolution(batch, {
      batchId: 'b1',
      decisions: [{ relPath: 'a.ts', hunkIndex: 0, accepted: false, comment: 'wrong approach' }]
    })
    expect(text).toContain('(reverted)')
    expect(text).toContain('wrong approach')
  })
})
