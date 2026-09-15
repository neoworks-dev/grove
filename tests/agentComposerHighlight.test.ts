// Splitting a composer draft into the runs the highlight layer paints. The layer
// sits under the caret, so the segments must always concatenate back to the draft.

import { describe, expect, test } from 'bun:test'
import { draftSegments, shellDraft } from '../src/renderer/src/lib/agents/completion'

function rebuilt(text: string): string {
  return draftSegments(text)
    .map((segment) => segment.text)
    .join('')
}

describe('draftSegments', () => {
  test('marks a mention that opens the draft', () => {
    expect(draftSegments('@src/app.ts')).toEqual([{ text: '@src/app.ts', mention: true }])
  })

  test('marks mentions between plain runs', () => {
    expect(draftSegments('look at @a.ts and @b.ts please')).toEqual([
      { text: 'look at ', mention: false },
      { text: '@a.ts', mention: true },
      { text: ' and ', mention: false },
      { text: '@b.ts', mention: true },
      { text: ' please', mention: false }
    ])
  })

  test('an @ inside a word is not a mention', () => {
    expect(draftSegments('mail me@example.com')).toEqual([
      { text: 'mail me@example.com', mention: false }
    ])
  })

  test('a lone @ has nothing to mark yet', () => {
    expect(draftSegments('ask @ ')).toEqual([{ text: 'ask @ ', mention: false }])
  })

  test('no draft, no segments', () => {
    expect(draftSegments('')).toEqual([])
  })

  test('the segments always rebuild the draft', () => {
    const drafts = ['@a', 'a @b\n@c d', 'plain text', '\n\n@x\t@y', '@a@b @c']
    for (const draft of drafts) {
      expect(rebuilt(draft)).toBe(draft)
    }
  })
})

describe('shellDraft', () => {
  test('a shared command is split at its marker', () => {
    expect(shellDraft('!git status')).toEqual({ lead: '', marker: '!', command: 'git status' })
  })

  test('a private command keeps both marks', () => {
    expect(shellDraft('!!echo hi')).toEqual({ lead: '', marker: '!!', command: 'echo hi' })
  })

  test('whitespace before the marker is kept, so the layer stays in register', () => {
    expect(shellDraft('  !ls')).toEqual({ lead: '  ', marker: '!', command: 'ls' })
  })

  test('a marker on its own has no command yet', () => {
    expect(shellDraft('!')).toEqual({ lead: '', marker: '!', command: '' })
  })

  test('a draft that is not shell has nothing to split', () => {
    expect(shellDraft('hello')).toBeNull()
    expect(shellDraft('/review the diff')).toBeNull()
    expect(shellDraft('mind the ! there')).toBeNull()
  })

  test('the parts always rebuild the draft', () => {
    const drafts = ['!ls -la', '!!grep -rn "a b" .', '  !echo hi\nand more', '!']
    for (const draft of drafts) {
      const parts = shellDraft(draft)
      expect(parts).not.toBeNull()
      expect(`${parts?.lead}${parts?.marker}${parts?.command}`).toBe(draft)
    }
  })
})
