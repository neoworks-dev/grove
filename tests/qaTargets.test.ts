import { describe, expect, test } from 'bun:test'
import { describeTarget, parseRegion, parseTarget } from '../scripts/qa/targets.ts'

describe('parseTarget', () => {
  test('a bare string is an accessible name', () => {
    expect(parseTarget('New session')).toEqual({ kind: 'name', name: 'New session' })
  })

  test('a probe ref is recognised by its shape', () => {
    expect(parseTarget('e14')).toEqual({ kind: 'ref', ref: 'e14' })
    // Not every name starting with an e is one.
    expect(parseTarget('edit')).toEqual({ kind: 'name', name: 'edit' })
  })

  test('a pane and a gutter are recognised by their shape too', () => {
    expect(parseTarget('leaf-3')).toEqual({ kind: 'leaf', leafId: 'leaf-3' })
    expect(parseTarget('split-1:0')).toEqual({ kind: 'gutter', splitId: 'split-1', index: 0 })
    // A label that only looks like one is still a label.
    expect(parseTarget('leaf-node')).toEqual({ kind: 'name', name: 'leaf-node' })
    expect(parseTarget('split-view')).toEqual({ kind: 'name', name: 'split-view' })
  })

  test('a role narrows a name to one role', () => {
    expect(parseTarget('role=button:Save')).toEqual({ kind: 'name', name: 'Save', role: 'button' })
  })

  test('a name containing an equals sign stays a name', () => {
    expect(parseTarget('width = 40')).toEqual({ kind: 'name', name: 'width = 40' })
  })

  test('a point carries two numbers', () => {
    expect(parseTarget('at=820,460')).toEqual({ kind: 'point', x: 820, y: 460 })
  })

  test('the other prefixes select their own lookup', () => {
    expect(parseTarget('text=Skip')).toEqual({ kind: 'text', text: 'Skip' })
    expect(parseTarget('testid=agent-mode-trigger')).toEqual({
      kind: 'testid',
      testId: 'agent-mode-trigger'
    })
    expect(parseTarget('css=.pane > button')).toEqual({ kind: 'css', selector: '.pane > button' })
  })

  test('a malformed target is an error rather than a guess', () => {
    expect(() => parseTarget('  ')).toThrow('empty target')
    expect(() => parseTarget('at=820')).toThrow('at=<x>,<y>')
    expect(() => parseTarget('at=left,middle')).toThrow('two numbers')
    expect(() => parseTarget('role=button')).toThrow('needs a name')
    expect(() => parseTarget('role=:Save')).toThrow('both parts')
  })
})

describe('describeTarget', () => {
  test('reads back as what was asked for', () => {
    expect(describeTarget(parseTarget('New session'))).toBe('"New session"')
    expect(describeTarget(parseTarget('role=tab:README.md'))).toBe('tab "README.md"')
    expect(describeTarget(parseTarget('at=1,2'))).toBe('point 1,2')
    expect(describeTarget(parseTarget('e3'))).toBe('e3')
    expect(describeTarget(parseTarget('leaf-3'))).toBe('pane leaf-3')
    expect(describeTarget(parseTarget('split-1:2'))).toBe('gutter split-1:2')
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
