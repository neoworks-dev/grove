// What a harness's write tools would leave on disk.
//
// The review flow diffs a pending write before it happens, which means grove has
// to model each harness's edit semantics exactly. Every adapter answers for its
// own tools, so both are pinned here.

import { describe, expect, test } from 'bun:test'
import { proposedContent as piContent } from '../src/main/agents/harnesses/pi'
import { proposedContent as claudeContent } from '../src/main/agents/harnesses/claude'

describe('pi write tools', () => {
  test('write replaces the whole file', () => {
    expect(piContent('write', { path: 'a.ts', content: 'next' }, 'previous')).toBe('next')
  })

  test('write with no content is not a change we can model', () => {
    expect(piContent('write', { path: 'a.ts' }, 'previous')).toBeNull()
  })

  test('edit applies one exact-match replacement', () => {
    const input = { path: 'a.ts', edits: [{ oldText: 'alpha', newText: 'beta' }] }
    expect(piContent('edit', input, 'alpha gamma')).toBe('beta gamma')
  })

  test('edit applies replacements in order, each against the previous result', () => {
    const input = {
      path: 'a.ts',
      edits: [
        { oldText: 'one', newText: 'two' },
        { oldText: 'two', newText: 'three' }
      ]
    }
    expect(piContent('edit', input, 'one')).toBe('three')
  })

  test('edit replaces only the first occurrence', () => {
    const input = { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }
    expect(piContent('edit', input, 'x x x')).toBe('y x x')
  })

  test('edit skips malformed entries rather than dropping the whole call', () => {
    const input = {
      path: 'a.ts',
      edits: [{ oldText: 'a', newText: 'b' }, { oldText: 42 }, { oldText: '', newText: 'z' }]
    }
    expect(piContent('edit', input, 'a c')).toBe('b c')
  })

  test('edit with no edits array is not a change we can model', () => {
    expect(piContent('edit', { path: 'a.ts' }, 'previous')).toBeNull()
  })

  test('a tool that is not a write is not modelled at all', () => {
    expect(piContent('bash', { command: 'rm -rf /' }, 'previous')).toBeNull()
    expect(piContent('read', { path: 'a.ts' }, 'previous')).toBeNull()
  })
})

describe('Claude write tools', () => {
  test('Write replaces the whole file', () => {
    expect(claudeContent('Write', { file_path: 'a.ts', content: 'next' }, 'previous')).toBe('next')
  })

  test('Edit replaces the first occurrence by default', () => {
    const input = { file_path: 'a.ts', old_string: 'x', new_string: 'y' }
    expect(claudeContent('Edit', input, 'x x x')).toBe('y x x')
  })

  test('Edit with replace_all replaces every occurrence', () => {
    const input = { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true }
    expect(claudeContent('Edit', input, 'x x x')).toBe('y y y')
  })

  test('MultiEdit applies its edits in order', () => {
    const input = {
      file_path: 'a.ts',
      edits: [
        { old_string: 'one', new_string: 'two' },
        { old_string: 'two', new_string: 'three' }
      ]
    }
    expect(claudeContent('MultiEdit', input, 'one')).toBe('three')
  })

  test('a notebook edit is not modelled as plain text', () => {
    expect(claudeContent('NotebookEdit', { notebook_path: 'a.ipynb' }, 'previous')).toBeNull()
  })

  test('a tool that is not a write is not modelled at all', () => {
    expect(claudeContent('Bash', { command: 'ls' }, 'previous')).toBeNull()
  })
})
