import { describe, expect, test } from 'bun:test'
import { relFromRoot, selectionRef } from '../src/renderer/src/lib/inlineEditRef'

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
