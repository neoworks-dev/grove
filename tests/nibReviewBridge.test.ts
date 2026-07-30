import { describe, expect, test } from 'bun:test'
import { proposedContent } from '../src/main/nib/reviewBridge'

describe('proposedContent', () => {
  test('write replaces the whole file', () => {
    expect(proposedContent('write', { path: 'a.ts', content: 'next' }, 'previous')).toBe('next')
  })

  test('write with no content is not a change we can model', () => {
    expect(proposedContent('write', { path: 'a.ts' }, 'previous')).toBeNull()
  })

  test('edit applies one exact-match replacement', () => {
    const input = { path: 'a.ts', edits: [{ oldText: 'alpha', newText: 'beta' }] }
    expect(proposedContent('edit', input, 'alpha gamma')).toBe('beta gamma')
  })

  test('edit applies replacements in order, each against the previous result', () => {
    const input = {
      path: 'a.ts',
      edits: [
        { oldText: 'one', newText: 'two' },
        { oldText: 'two', newText: 'three' }
      ]
    }
    expect(proposedContent('edit', input, 'one')).toBe('three')
  })

  test('edit replaces only the first occurrence, the way nib does', () => {
    const input = { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }
    expect(proposedContent('edit', input, 'x x x')).toBe('y x x')
  })

  test('edit skips malformed entries rather than dropping the whole call', () => {
    const input = {
      path: 'a.ts',
      edits: [{ oldText: 'a', newText: 'b' }, { oldText: 42 }, { oldText: '', newText: 'z' }]
    }
    expect(proposedContent('edit', input, 'a c')).toBe('b c')
  })

  test('edit with no edits array is not a change we can model', () => {
    expect(proposedContent('edit', { path: 'a.ts' }, 'previous')).toBeNull()
  })

  test('a tool that is not a write is not modelled at all', () => {
    expect(proposedContent('bash', { command: 'rm -rf /' }, 'previous')).toBeNull()
    expect(proposedContent('read', { path: 'a.ts' }, 'previous')).toBeNull()
  })
})
