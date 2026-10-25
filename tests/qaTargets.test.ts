import { describe, expect, test } from 'bun:test'
import { describeTarget, parseRegion, parseTarget } from '../scripts/qa/targets.ts'

describe('parseTarget', () => {
  test('a bare string is text to find on screen', () => {
    expect(parseTarget('New session')).toEqual({ kind: 'text', text: 'New session' })
    expect(parseTarget('width = 40')).toEqual({ kind: 'text', text: 'width = 40' })
  })

  test('text= spells it out, for text that would read as something else', () => {
    expect(parseTarget('text=at=1,2')).toEqual({ kind: 'text', text: 'at=1,2' })
  })

  test('a point carries two numbers, rounded to pixels', () => {
    expect(parseTarget('at=820,460')).toEqual({ kind: 'point', x: 820, y: 460 })
    expect(parseTarget('at=820.6, 459.5')).toEqual({ kind: 'point', x: 821, y: 460 })
  })

  test('a malformed target is an error rather than a guess', () => {
    expect(() => parseTarget('  ')).toThrow('empty')
    expect(() => parseTarget('text=')).toThrow('empty')
    expect(() => parseTarget('at=820')).toThrow('two numbers')
    expect(() => parseTarget('at=left,middle')).toThrow('two numbers')
  })
})

describe('describeTarget', () => {
  test('reads back the way it was meant', () => {
    expect(describeTarget(parseTarget('New session'))).toBe('"New session"')
    expect(describeTarget(parseTarget('at=1,2'))).toBe('point 1,2')
  })
})

describe('parseRegion', () => {
  test('four numbers are a rectangle of the window', () => {
    expect(parseRegion('400,40,520,60')).toEqual({ x: 400, y: 40, width: 520, height: 60 })
    expect(parseRegion(' 0, 0 ,10,10 ')).toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })

  test('anything else is an error rather than a picture of the wrong thing', () => {
    expect(() => parseRegion('400,40,520')).toThrow('four numbers')
    expect(() => parseRegion('400,40,520,wide')).toThrow('four numbers')
    expect(() => parseRegion('400,40,0,60')).toThrow('positive width and height')
    expect(() => parseRegion('400,40,520,-60')).toThrow('positive width and height')
  })
})
