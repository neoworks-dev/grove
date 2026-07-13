import { describe, expect, test } from 'bun:test'
import { pickAgentMode, relFromRoot, selectionRef } from '../src/renderer/src/lib/inlineEditRef'

// The claude adapter's mode vocabulary.
const CLAUDE_MODES = [
  { label: 'manual review', value: 'default' },
  { label: 'plan', value: 'plan' },
  { label: 'accept edits', value: 'acceptEdits' },
  { label: 'auto', value: 'bypassPermissions' }
]

describe('relFromRoot', () => {
  test('strips the worktree root prefix', () => {
    expect(relFromRoot('/home/me/wt', '/home/me/wt/src/foo.ts')).toBe('src/foo.ts')
  })

  test('passes through paths outside the worktree', () => {
    expect(relFromRoot('/home/me/wt', '/etc/hosts')).toBe('/etc/hosts')
  })

  test('does not treat a sibling dir with a shared prefix as inside', () => {
    expect(relFromRoot('/home/me/wt', '/home/me/wt-other/x.ts')).toBe('/home/me/wt-other/x.ts')
  })

  test('returns the absolute path when the root is unknown', () => {
    expect(relFromRoot(undefined, '/home/me/wt/src/foo.ts')).toBe('/home/me/wt/src/foo.ts')
  })
})

describe('selectionRef', () => {
  test('collapses a single-line selection to path:line', () => {
    expect(selectionRef('src/foo.ts', 12, 12)).toBe('src/foo.ts:12')
  })

  test('formats a multi-line range as path:start-end', () => {
    expect(selectionRef('src/foo.ts', 12, 20)).toBe('src/foo.ts:12-20')
  })
})

describe('pickAgentMode', () => {
  test('gated maps to the manual/default permission mode', () => {
    expect(pickAgentMode(CLAUDE_MODES, 'gated')).toBe('default')
  })

  test('inline maps to acceptEdits so the write lands, then the overlay reviews', () => {
    expect(pickAgentMode(CLAUDE_MODES, 'inline')).toBe('acceptEdits')
  })

  test('auto also applies edits via acceptEdits', () => {
    expect(pickAgentMode(CLAUDE_MODES, 'auto')).toBe('acceptEdits')
  })

  test('falls back to the first declared mode for an unknown vocabulary', () => {
    const modes = [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }]
    expect(pickAgentMode(modes, 'inline')).toBe('x')
    expect(pickAgentMode(modes, 'gated')).toBe('x')
  })

  test('returns undefined when the adapter declares no modes', () => {
    expect(pickAgentMode([], 'inline')).toBeUndefined()
  })
})
