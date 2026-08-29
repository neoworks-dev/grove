// Guards the Neovim LSP reference payload boundary: malformed and duplicate
// locations must never become ambiguous rows in Grove's references overlay.

import { describe, expect, test } from 'bun:test'
import {
  normalizeNvimReferences,
  referenceMatchesQuery
} from '../src/renderer/src/lib/nvimReferences'

describe('normalizeNvimReferences', () => {
  test('validates, deduplicates, and orders locations', () => {
    expect(
      normalizeNvimReferences([
        reference('/repo/z.ts', 8, 3),
        reference('/repo/a.ts', 4, 1),
        reference('/repo/a.ts', 4, 1),
        { ...reference('/repo/missing-uri.ts', 0, 0), uri: '' },
        { ...reference('/repo/a.ts', 0, 0), line: -1 },
        { ...reference('/repo/a.ts', 0, 0), endCol: 2.5 },
        null
      ])
    ).toEqual([reference('/repo/a.ts', 4, 1), reference('/repo/z.ts', 8, 3)])
  })

  test('rejects a non-list RPC result', () => {
    expect(normalizeNvimReferences(reference('/repo/a.ts', 1, 0))).toEqual([])
  })
})

function reference(path: string, line: number, col: number) {
  return {
    path,
    uri: `file://${path}`,
    line,
    col,
    endLine: line,
    endCol: col + 3,
    encoding: 'utf-16'
  }
}

describe('referenceMatchesQuery', () => {
  const location = reference('/repo/src/main.ts', 9, 4)

  test('matches file, one-based location, and symbol terms', () => {
    expect(referenceMatchesQuery(location, 'main.ts 10:5')).toBe(true)
    expect(referenceMatchesQuery(location, 'render', 'renderFrame')).toBe(true)
    expect(referenceMatchesQuery(location, 'other', 'renderFrame')).toBe(false)
  })
})
