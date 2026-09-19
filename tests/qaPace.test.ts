import { describe, expect, test } from 'bun:test'
import { emptyPace, noteAction, notePicture, refusePicture } from '../scripts/qa/pace.ts'

describe('refusePicture', () => {
  test('the first picture of a session is always allowed', () => {
    expect(refusePicture(emptyPace(), 'full')).toBeNull()
  })

  test('a second picture of the same frame is refused', () => {
    const pace = notePicture(emptyPace(), 'full', 'shots/001-a.png')
    expect(refusePicture(pace, 'full')).toContain('nothing has happened since shots/001-a.png')
  })

  test('one closer look at the same screen is allowed', () => {
    const pace = notePicture(emptyPace(), 'full', 'shots/001-a.png')
    expect(refusePicture(pace, 'crop:0,0,300,300')).toBeNull()
  })

  test('but only one — reframing is not a way round the rule', () => {
    let pace = notePicture(emptyPace(), 'full', 'shots/001-a.png')
    pace = notePicture(pace, 'crop:0,0,300,300', 'shots/002-b.png')
    expect(refusePicture(pace, 'crop:10,10,200,200')).toContain('2 pictures of this screen')
    expect(refusePicture(pace, 'of:leaf-3')).toContain('2 pictures of this screen')
  })

  test('acting on the app gives the allowance back', () => {
    let pace = notePicture(emptyPace(), 'full', 'shots/001-a.png')
    pace = notePicture(pace, 'crop:0,0,300,300', 'shots/002-b.png')
    pace = noteAction(pace)
    expect(refusePicture(pace, 'full')).toBeNull()
  })

  test('the running total survives the allowance being reset', () => {
    let pace = notePicture(emptyPace(), 'full', 'shots/001-a.png')
    pace = noteAction(pace)
    pace = notePicture(pace, 'full', 'shots/002-b.png')
    expect(pace.taken).toBe(2)
    expect(pace.sinceAction).toBe(1)
  })
})
