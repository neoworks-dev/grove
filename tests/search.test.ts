import { describe, it, expect } from 'bun:test'
import { parseRgMatch } from '../src/main/search'

describe('parseRgMatch', () => {
  it('parses a ripgrep match event', () => {
    const line = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/foo.ts' },
        lines: { text: '  const answer = 42\n' },
        line_number: 12,
        submatches: [{ match: { text: 'answer' }, start: 8, end: 14 }]
      }
    })
    expect(parseRgMatch(line)).toEqual({
      file: 'src/foo.ts',
      line: 12,
      column: 8,
      text: '  const answer = 42'
    })
  })

  it('ignores non-match events (begin/end/summary)', () => {
    expect(parseRgMatch(JSON.stringify({ type: 'begin', data: { path: { text: 'x' } } }))).toBeNull()
    expect(parseRgMatch(JSON.stringify({ type: 'summary', data: {} }))).toBeNull()
  })

  it('ignores malformed / non-JSON lines', () => {
    expect(parseRgMatch('not json')).toBeNull()
    expect(parseRgMatch('')).toBeNull()
  })

  it('defaults column to 0 when there are no submatches', () => {
    const line = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, lines: { text: 'hit\n' }, line_number: 1 }
    })
    expect(parseRgMatch(line)?.column).toBe(0)
  })
})
