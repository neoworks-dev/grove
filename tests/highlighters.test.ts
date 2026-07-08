import { describe, it, expect } from 'bun:test'
import { registerHighlighter, resolveHighlighter } from '../src/renderer/src/lib/highlighters'
import type { Extension } from '@codemirror/state'

// build() returns an Extension; use string sentinels to assert which won.
const sentinel = (value: string): Extension => value as unknown as Extension

describe('highlighter registry', () => {
  it('picks the highest-priority provider for an extension', () => {
    const offLezer = registerHighlighter({
      id: 'rs-lezer',
      extensions: ['rs'],
      priority: 1,
      build: () => sentinel('lezer')
    })
    const offTs = registerHighlighter({
      id: 'rs-ts',
      extensions: ['rs'],
      priority: 10,
      build: () => sentinel('treesitter')
    })
    expect(resolveHighlighter('main.rs')).toBe('treesitter' as unknown as Extension)
    offTs()
    expect(resolveHighlighter('main.rs')).toBe('lezer' as unknown as Extension)
    offLezer()
    expect(resolveHighlighter('main.rs')).toBeNull()
  })

  it('returns null for an unhandled extension', () => {
    expect(resolveHighlighter('file.unknownext')).toBeNull()
  })
})
