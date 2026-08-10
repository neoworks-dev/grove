import { describe, it, expect } from 'bun:test'
import {
  decodeNvimKey,
  isPendingSequence,
  nextPending,
  pendingHint
} from '../src/renderer/src/lib/nvimPendingKeys'
import type { NvimMapping } from '../src/renderer/src/lib/nvimKeymap'

const MAPS: NvimMapping[] = [
  { lhs: 'gcc', rhs: '', desc: 'comment line' },
  { lhs: 'gco', rhs: '', desc: 'comment below' },
  { lhs: 'ys', rhs: '', desc: 'surround' },
  { lhs: '<Plug>(MatchitOperationForward)', rhs: ':<C-U>call matchit#Match()', desc: null },
  { lhs: 'p', rhs: '', desc: 'paste' }
]

describe('decodeNvimKey', () => {
  it('passes printable keys through', () => {
    expect(decodeNvimKey('g')).toBe('g')
    expect(decodeNvimKey('5')).toBe('5')
    expect(decodeNvimKey('"')).toBe('"')
  })

  it('names the control keys', () => {
    expect(decodeNvimKey('\x1b')).toBe('<Esc>')
    expect(decodeNvimKey('\r')).toBe('<CR>')
    expect(decodeNvimKey('\t')).toBe('<Tab>')
  })

  it('decodes ctrl chords', () => {
    expect(decodeNvimKey('\x17')).toBe('<C-w>')
  })

  it('rejects K_SPECIAL sequences and empty input', () => {
    expect(decodeNvimKey('\x80kb')).toBeNull()
    expect(decodeNvimKey('')).toBeNull()
  })
})

describe('isPendingSequence', () => {
  it('treats a count as pending', () => {
    expect(isPendingSequence('5', MAPS)).toBe(true)
    expect(isPendingSequence('42', MAPS)).toBe(true)
  })

  it('does not treat a leading zero as a count', () => {
    expect(isPendingSequence('0', MAPS)).toBe(false)
  })

  it('recognizes builtin prefix layers, with or without a count', () => {
    expect(isPendingSequence('g', MAPS)).toBe(true)
    expect(isPendingSequence('<C-w>', MAPS)).toBe(true)
    expect(isPendingSequence('5g', MAPS)).toBe(true)
  })

  it('recognizes prefixes of live mappings', () => {
    expect(isPendingSequence('y', MAPS)).toBe(true)
  })

  it('rejects resolved keys and unknown prefixes', () => {
    expect(isPendingSequence('p', MAPS)).toBe(false)
    expect(isPendingSequence('x', MAPS)).toBe(false)
    expect(isPendingSequence('', MAPS)).toBe(false)
  })
})

describe('nextPending', () => {
  it('accumulates a count then a prefix', () => {
    const afterCount = nextPending('', '5', MAPS)
    expect(afterCount).toBe('5')
    expect(nextPending(afterCount, 'g', MAPS)).toBe('5g')
  })

  it('clears once the sequence resolves', () => {
    expect(nextPending('g', 'g', MAPS)).toBe('')
    expect(nextPending('', 'x', MAPS)).toBe('')
  })

  it('escape cancels', () => {
    expect(nextPending('5g', '<Esc>', MAPS)).toBe('')
  })

  it('keeps going while a mapping is still reachable', () => {
    expect(nextPending('g', 'c', MAPS)).toBe('gc')
  })
})

describe('pendingHint', () => {
  it('titles a bare count and lists the top-level layer', () => {
    const hint = pendingHint('5', MAPS)
    expect(hint?.title).toBe('count 5')
    expect(hint?.entries.some((entry) => entry.keys === 'j')).toBe(true)
    // A count has no prefix, so live mappings must not be dumped in wholesale.
    expect(hint?.entries.some((entry) => entry.description === 'surround')).toBe(false)
  })

  it('names a builtin layer and merges live mappings under it', () => {
    const hint = pendingHint('g', MAPS)
    expect(hint?.title).toBe('goto')
    expect(hint?.entries.find((entry) => entry.keys === 'cc')?.description).toBe('comment line')
    expect(hint?.entries.find((entry) => entry.keys === 'g')?.description).toBe('first line')
  })

  it('keeps the count in the title of a prefixed layer', () => {
    expect(pendingHint('3z', MAPS)?.title).toBe('3 fold & scroll')
  })

  it('builds a layer from mappings alone', () => {
    const hint = pendingHint('y', MAPS)
    expect(hint?.title).toBe('y')
    expect(hint?.entries).toEqual([{ keys: 's', description: 'surround' }])
  })

  it('leaves out <Plug> hooks, which nobody can type', () => {
    expect(isPendingSequence('<', MAPS)).toBe(false)
    const hint = pendingHint('g', MAPS)
    expect(hint?.entries.every((entry) => !entry.keys.includes('Matchit'))).toBe(true)
  })

  it('returns null when nothing is pending', () => {
    expect(pendingHint('', MAPS)).toBeNull()
    expect(pendingHint('x', MAPS)).toBeNull()
  })
})
