import { describe, it, expect } from 'bun:test'
import {
  parseSequence,
  formatSequence,
  normalizeSequence,
  stepFromEvent,
  sequenceStartsWith,
  findConflicts,
  type KeyStep
} from '../src/renderer/src/lib/keySequence'

function step(key: string, mods: Partial<Omit<KeyStep, 'key'>> = {}): KeyStep {
  return { key, ctrl: false, alt: false, shift: false, meta: false, ...mods }
}

describe('parseSequence', () => {
  it('parses a leader sequence', () => {
    const parsed = parseSequence('leader a b')
    expect(parsed).toEqual({ leader: true, steps: [step('a'), step('b')] })
  })

  it('parses modifier chords', () => {
    const parsed = parseSequence('ctrl+k ctrl+s')
    expect(parsed).toEqual({
      leader: false,
      steps: [step('k', { ctrl: true }), step('s', { ctrl: true })]
    })
  })

  it('parses named keys and single chords', () => {
    expect(parseSequence('leader space')).toEqual({ leader: true, steps: [step('space')] })
    expect(parseSequence('ctrl+h')).toEqual({ leader: false, steps: [step('h', { ctrl: true })] })
    expect(parseSequence('f1')).toEqual({ leader: false, steps: [step('f1')] })
  })

  it('normalizes bare shift+letter to the uppercase character', () => {
    expect(parseSequence('shift+f')).toEqual({ leader: false, steps: [step('F')] })
  })

  it('lowercases chord characters and keeps shift', () => {
    expect(parseSequence('ctrl+shift+P')).toEqual({
      leader: false,
      steps: [step('p', { ctrl: true, shift: true })]
    })
  })

  it('rejects invalid input', () => {
    expect(parseSequence('')).toBeNull()
    expect(parseSequence('leader')).toBeNull()
    expect(parseSequence('a leader b')).toBeNull()
    expect(parseSequence('hyper+k')).toBeNull()
    expect(parseSequence('ctrl+')).toBeNull()
    expect(parseSequence('notakey')).toBeNull()
    expect(parseSequence('shift+1')).toBeNull()
  })

  it('parses the bracket grammar', () => {
    expect(parseSequence('<Leader> a b')).toEqual({ leader: true, steps: [step('a'), step('b')] })
    expect(parseSequence('<Ctrl-K> <Ctrl-S>')).toEqual({
      leader: false,
      steps: [step('k', { ctrl: true }), step('s', { ctrl: true })]
    })
    expect(parseSequence('<Leader> <Space>')).toEqual({ leader: true, steps: [step('space')] })
    expect(parseSequence('<Alt-Q>')).toEqual({ leader: false, steps: [step('q', { alt: true })] })
    expect(parseSequence('<C-S-P>')).toEqual({
      leader: false,
      steps: [step('p', { ctrl: true, shift: true })]
    })
  })

  it('accepts old and new grammar interchangeably', () => {
    expect(parseSequence('<Leader> w h')).toEqual(parseSequence('leader w h'))
    expect(parseSequence('<Ctrl-H>')).toEqual(parseSequence('ctrl+h'))
  })
})

describe('formatSequence / normalizeSequence', () => {
  it('round-trips canonical text', () => {
    for (const text of [
      '<Leader> a b',
      '<Ctrl-K> <Ctrl-S>',
      '<Leader> <Space>',
      'F',
      '<Ctrl-Alt-Shift-X>'
    ]) {
      expect(formatSequence(parseSequence(text)!)).toBe(text)
    }
  })

  it('normalizes the old grammar into the bracket form', () => {
    expect(normalizeSequence('shift+ctrl+P')).toBe('<Ctrl-Shift-P>')
    expect(normalizeSequence('  leader   a  ')).toBe('<Leader> a')
    expect(normalizeSequence('META+ENTER')).toBe('<Meta-Enter>')
    expect(normalizeSequence('leader w h')).toBe('<Leader> w h')
    expect(normalizeSequence('bogus+x')).toBeNull()
  })
})

describe('stepFromEvent', () => {
  function keyEvent(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent
  }

  it('maps named keys', () => {
    expect(stepFromEvent(keyEvent(' '))).toEqual(step('space'))
    expect(stepFromEvent(keyEvent('ArrowUp'))).toEqual(step('up'))
    expect(stepFromEvent(keyEvent('Escape'))).toEqual(step('escape'))
    expect(stepFromEvent(keyEvent('F5'))).toEqual(step('f5'))
  })

  it('drops shift for bare printable characters (the character encodes it)', () => {
    expect(stepFromEvent(keyEvent('F', { shiftKey: true }))).toEqual(step('F'))
  })

  it('keeps shift and lowercases the character inside chords', () => {
    expect(stepFromEvent(keyEvent('P', { ctrlKey: true, shiftKey: true }))).toEqual(
      step('p', { ctrl: true, shift: true })
    )
  })
})

describe('sequenceStartsWith', () => {
  it('matches step prefixes exactly', () => {
    const seq = parseSequence('ctrl+k ctrl+s')!.steps
    expect(sequenceStartsWith(seq, parseSequence('ctrl+k')!.steps)).toBe(true)
    expect(sequenceStartsWith(seq, parseSequence('k')!.steps)).toBe(false)
    expect(sequenceStartsWith(seq, seq)).toBe(true)
  })
})

describe('findConflicts', () => {
  function entry(id: string, keys: string, context = 'global') {
    return { id, context, sequence: parseSequence(keys)! }
  }

  it('reports exact duplicates in the same context', () => {
    const conflicts = findConflicts([entry('a', 'leader x'), entry('b', 'leader x')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('duplicate')
  })

  it('reports prefix shadowing', () => {
    const conflicts = findConflicts([entry('short', 'leader w'), entry('long', 'leader w h')])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].kind).toBe('shadow')
  })

  it('ignores different contexts and leader/non-leader differences', () => {
    expect(findConflicts([entry('a', 'leader x', 'tree'), entry('b', 'leader x', 'global')])).toHaveLength(0)
    expect(findConflicts([entry('a', 'leader x'), entry('b', 'x')])).toHaveLength(0)
  })
})
