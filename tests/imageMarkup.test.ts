// Marking up an image in the composer: the marks' history, which drags count,
// and which version of the image a message carries.

import { describe, expect, test } from 'bun:test'
import {
  addMark,
  arrowHead,
  commit,
  isMeaningful,
  rectBetween,
  redo,
  startHistory,
  undo,
  type Mark
} from '../src/renderer/src/lib/agents/imageMarkup'
import {
  attachedImage,
  marksOf,
  sentImage,
  withMarkup,
  withoutMarkup
} from '../src/renderer/src/lib/agents/composerImages'

const box: Mark = { kind: 'box', rect: { x: 0, y: 0, width: 20, height: 20 }, color: 'red', width: 2 }
const arrow: Mark = { kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, color: 'red', width: 2 }

describe('the marks’ history', () => {
  test('undo takes the last mark off, redo puts it back', () => {
    let history = addMark(addMark(startHistory([]), box), arrow)
    history = undo(history)
    expect(history.present).toEqual([box])
    history = redo(history)
    expect(history.present).toEqual([box, arrow])
  })

  test('a new mark after an undo drops what was undone', () => {
    let history = addMark(addMark(startHistory([]), box), arrow)
    history = addMark(undo(history), arrow)
    expect(history.future).toEqual([])
    expect(redo(history)).toBe(history)
  })

  test('back to the original is one step, and undone like any other', () => {
    let history = addMark(addMark(startHistory([]), box), arrow)
    history = commit(history, [])
    expect(history.present).toEqual([])
    expect(undo(history).present).toEqual([box, arrow])
  })

  test('reopened, it carries on from the marks it was left with, with nothing to undo', () => {
    const history = startHistory([box])
    expect(history.present).toEqual([box])
    expect(undo(history)).toBe(history)
  })
})

describe('what a drag makes', () => {
  test('a rectangle is the same whichever way it was dragged', () => {
    expect(rectBetween({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 20, height: 35 })
  })

  test('a click that slipped is not a mark', () => {
    expect(isMeaningful({ ...box, rect: { x: 0, y: 0, width: 2, height: 30 } })).toBe(false)
    expect(isMeaningful({ ...arrow, to: { x: 1, y: 1 } })).toBe(false)
    expect(isMeaningful({ kind: 'text', at: { x: 0, y: 0 }, text: '  ', color: 'red', size: 14 })).toBe(false)
    expect(isMeaningful(box)).toBe(true)
  })

  test('an arrow’s head sweeps back from its tip on both sides', () => {
    const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)
    expect(left.x).toBeLessThan(100)
    expect(right.x).toBeLessThan(100)
    expect(Math.sign(left.y)).toBe(-Math.sign(right.y))
  })
})

describe('the image a message carries', () => {
  const original = { type: 'image' as const, ref: 'original', mediaType: 'image/png' }
  const marked = { type: 'image' as const, ref: 'marked', mediaType: 'image/png' }

  test('the marked-up version while there is one, the original once it is taken off', () => {
    const attached = attachedImage(original, new Blob(['a']))
    expect(sentImage(attached)).toEqual(original)

    const markedUp = withMarkup(attached, marked, new Blob(['b']), [box])
    expect(sentImage(markedUp)).toEqual(marked)
    expect(marksOf(markedUp)).toEqual([box])
    expect(markedUp.id).toBe(attached.id)

    const restored = withoutMarkup(markedUp)
    expect(sentImage(restored)).toEqual(original)
    expect(marksOf(restored)).toEqual([])
  })
})
