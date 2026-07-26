import { describe, it, expect } from 'bun:test'
import { describeResolution } from '../src/main/review'
import { proposedContent, FILE_WRITE_TOOLS } from '../src/main/proposedEdit'
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

describe('proposedContent', () => {
  it('takes a Write tool at its word', () => {
    expect(proposedContent('Write', { content: 'new body' }, 'old body')).toBe('new body')
  })

  it('applies an Edit replacement once by default', () => {
    expect(proposedContent('Edit', { old_string: 'a', new_string: 'b' }, 'a a')).toBe('b a')
  })

  it('applies an Edit replacement everywhere with replace_all', () => {
    const result = proposedContent(
      'Edit',
      { old_string: 'a', new_string: 'b', replace_all: true },
      'a a'
    )
    expect(result).toBe('b b')
  })

  it('applies MultiEdit edits in order, each seeing the previous result', () => {
    const result = proposedContent(
      'MultiEdit',
      { edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'two', new_string: 'three' }] },
      'one'
    )
    expect(result).toBe('three')
  })

  it('returns null for a tool it cannot model', () => {
    expect(proposedContent('Bash', { command: 'ls' }, '')).toBeNull()
  })

  it('leaves the file alone when the Edit has an empty old_string', () => {
    expect(proposedContent('Edit', { old_string: '', new_string: 'x' }, 'body')).toBe('body')
  })

  it('covers exactly the tools the gated review path recognises', () => {
    expect([...FILE_WRITE_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'Write'])
  })
})
