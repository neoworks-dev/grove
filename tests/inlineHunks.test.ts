import { describe, it, expect } from 'bun:test'
import { rebuildWithAccepted } from '../src/shared/inlineHunks'
import type { InlineHunk } from '../src/shared/types'

// The marks are what the editor paints a review with: which lines a hunk
// produced, and which lines it replaced. They have to describe the content the
// user is actually looking at, so they are asserted against the rebuilt text.

function linesOf(content: string): string[] {
  return content.split('\n')
}

describe('rebuildWithAccepted marks', () => {
  it('marks an insertion at the line it inserted', () => {
    const hunks: InlineHunk[] = [{ beforeStart: 2, removed: [], afterStart: 3, added: ['two.5'] }]

    const { content, marks } = rebuildWithAccepted('one\ntwo\nthree', hunks, [true])

    expect(linesOf(content)).toEqual(['one', 'two', 'two.5', 'three'])
    expect(marks).toEqual([{ hunkIndex: 0, start: 3, added: 1, removed: [] }])
  })

  it('marks a replacement at its new lines and carries what it replaced', () => {
    const hunks: InlineHunk[] = [
      { beforeStart: 2, removed: ['two'], afterStart: 2, added: ['TWO'] }
    ]

    const { content, marks } = rebuildWithAccepted('one\ntwo\nthree', hunks, [true])

    expect(linesOf(content)).toEqual(['one', 'TWO', 'three'])
    expect(marks).toEqual([{ hunkIndex: 0, start: 2, added: 1, removed: ['two'] }])
  })

  it('marks a pure deletion at the line that closed over it', () => {
    const hunks: InlineHunk[] = [{ beforeStart: 2, removed: ['two'], afterStart: 1, added: [] }]

    const { content, marks } = rebuildWithAccepted('one\ntwo\nthree', hunks, [true])

    // Nothing was added, so there is no range to tint — but the removed line
    // still has to be shown, anchored where it used to be.
    expect(linesOf(content)).toEqual(['one', 'three'])
    expect(marks).toEqual([{ hunkIndex: 0, start: 2, added: 0, removed: ['two'] }])
  })

  it('reports nothing for a hunk that was reverted', () => {
    const hunks: InlineHunk[] = [
      { beforeStart: 1, removed: ['one'], afterStart: 1, added: ['ONE'] },
      { beforeStart: 3, removed: ['three'], afterStart: 3, added: ['THREE'] }
    ]

    const { content, marks, ranges } = rebuildWithAccepted('one\ntwo\nthree', hunks, [false, true])

    expect(linesOf(content)).toEqual(['one', 'two', 'THREE'])
    expect(marks.map((mark) => mark.hunkIndex)).toEqual([1])
    expect(ranges).toEqual([{ hunkIndex: 1, start: 3, count: 1 }])
  })

  it('keeps later marks in step with the lines earlier hunks shifted', () => {
    const hunks: InlineHunk[] = [
      { beforeStart: 1, removed: ['one'], afterStart: 1, added: ['ONE', 'extra'] },
      { beforeStart: 3, removed: ['three'], afterStart: 4, added: ['THREE'] }
    ]

    const { content, marks } = rebuildWithAccepted('one\ntwo\nthree', hunks, [true, true])

    expect(linesOf(content)).toEqual(['ONE', 'extra', 'two', 'THREE'])
    // The second hunk moved down a line because the first added one.
    expect(marks[1]).toEqual({ hunkIndex: 1, start: 4, added: 1, removed: ['three'] })
  })
})
