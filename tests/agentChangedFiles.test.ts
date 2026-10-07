// What a folded turn lists as changed: one entry per file, line counts summed across
// every edit to it, from ACP diffs where the harness sent them and the input otherwise.

import { describe, expect, test } from 'bun:test'
import { changedFilesOf } from '../src/renderer/src/lib/agents/changedFiles'
import { foldTurn, foldedCalls } from '../src/renderer/src/lib/agents/turns'
import { toTranscriptRows } from '../src/renderer/src/lib/agents/toolRuns'
import type {
  ToolItem,
  ToolStatus,
  TranscriptItem
} from '../src/renderer/src/lib/agents/transcript'

let nextEventId = 0

/** A finished call carrying the given diff content and input. */
function editCall(
  content: { type: string; path?: string; oldText?: string | null; newText?: string }[],
  input: unknown = {},
  status: ToolStatus = 'ok'
): ToolItem {
  nextEventId += 1
  return {
    kind: 'tool',
    seq: nextEventId,
    eventId: `e${nextEventId}`,
    toolUseId: `t${nextEventId}`,
    name: 'Edit',
    title: '',
    toolKind: 'edit',
    input,
    editedInput: null,
    permission: 'allow',
    status,
    progress: '',
    result: '',
    rawResult: '',
    images: [],
    content,
    locations: [],
    spawn: null
  } as ToolItem
}

const pathOfInput = (call: ToolItem): string | null => {
  const input = call.input as { path?: string }
  return input.path ?? null
}

describe('changedFilesOf', () => {
  test('merges edits to one file and sums their lines', () => {
    const files = changedFilesOf(
      [
        editCall([{ type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }]),
        editCall([{ type: 'diff', path: '/w/b.ts', oldText: null, newText: 'x\ny\n' }]),
        editCall([{ type: 'diff', path: '/w/a.ts', oldText: 'one\n', newText: 'one\nthree\n' }])
      ],
      pathOfInput
    )
    expect(files).toEqual([
      { path: '/w/a.ts', added: 2, removed: 1, created: false },
      { path: '/w/b.ts', added: 2, removed: 0, created: true }
    ])
  })

  test('falls back to the input for a call without diff content', () => {
    const files = changedFilesOf(
      [editCall([], { path: 'src/c.ts', edits: [{ oldText: 'a', newText: 'b\nc' }] })],
      pathOfInput
    )
    expect(files).toEqual([{ path: 'src/c.ts', added: 2, removed: 1, created: false }])
  })

  test('skips calls that failed or were refused', () => {
    const diff = [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' }]
    const files = changedFilesOf(
      [editCall(diff, {}, 'error'), editCall(diff, {}, 'denied')],
      pathOfInput
    )
    expect(files).toEqual([])
  })
})

describe('foldTurn with edits', () => {
  test('folds a settled edit when only images stand alone', () => {
    const answer: TranscriptItem = {
      kind: 'agent',
      seq: 999,
      eventId: 'answer',
      text: 'done',
      thinking: '',
      streaming: false
    } as TranscriptItem
    const edit = editCall([{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' }])
    const isEdit = (call: ToolItem): boolean => call.toolKind === 'edit'
    const rows = toTranscriptRows([edit, answer], isEdit)
    const fold = foldTurn(rows, (call) => call.images.length > 0)

    expect(foldedCalls(fold.hidden)).toEqual([edit])
    expect(fold.kept).toHaveLength(1)
  })
})
