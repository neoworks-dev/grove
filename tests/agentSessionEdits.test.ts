// The files a session edited, and each one as it would be without those edits.
//
// The chat pane's edits overlay diffs a file against the second of these, so
// what the user changed beside the agent has to survive the undoing.

import { describe, expect, test } from 'bun:test'
import type { SessionEvent } from '../src/shared/agents'
import { tmpdir } from 'node:os'
import { hunksBetween } from '../src/main/inlineDiff'
import {
  relativeInside,
  sessionEdits,
  textWithoutEdits
} from '../src/main/agents/sessionEdits'

let seq = 0

/** Line hunks, diffed by git as the service does. */
function diffLines(before: string, after: string): ReturnType<typeof hunksBetween> {
  return hunksBetween(tmpdir(), before, after)
}

/** A tool call update on the log, carrying the given diffs and status. */
function toolUpdate(
  toolCallId: string,
  options: {
    first?: boolean
    status?: string
    diffs?: { path: string; oldText: string | null; newText: string }[]
    text?: string
  }
): SessionEvent {
  seq += 1
  const content: unknown[] = []
  for (const diff of options.diffs ?? []) content.push({ type: 'diff', ...diff })
  if (options.text) content.push({ type: 'content', content: { type: 'text', text: options.text } })
  return {
    seq,
    sessionId: 's1',
    createdAt: '2026-10-01T00:00:00Z',
    type: 'update',
    update: {
      sessionUpdate: options.first ? 'tool_call' : 'tool_call_update',
      toolCallId,
      status: options.status,
      content: content.length > 0 ? content : undefined,
      title: 'Edit'
    }
  } as unknown as SessionEvent
}

describe('the edits on a session log', () => {
  test('a completed call counts, keeping its diffs past a result that replaces them', () => {
    const events = [
      toolUpdate('c1', { first: true, status: 'pending', diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] }),
      toolUpdate('c1', { status: 'completed', text: 'The file has been updated.' })
    ]
    const edits = sessionEdits(events)
    expect([...edits.keys()]).toEqual(['/w/a.ts'])
    expect(edits.get('/w/a.ts')).toEqual([{ path: '/w/a.ts', oldText: 'a', newText: 'b' }])
  })

  test('a failed or unfinished call does not', () => {
    const events = [
      toolUpdate('c1', { first: true, diffs: [{ path: '/w/a.ts', oldText: 'a', newText: 'b' }] }),
      toolUpdate('c1', { status: 'failed' }),
      toolUpdate('c2', { first: true, diffs: [{ path: '/w/b.ts', oldText: 'a', newText: 'b' }] })
    ]
    expect(sessionEdits(events).size).toBe(0)
  })

  test('files are listed in the order they were first edited', () => {
    const events = [
      toolUpdate('c1', { first: true, status: 'completed', diffs: [{ path: '/w/b.ts', oldText: null, newText: 'x' }] }),
      toolUpdate('c2', { first: true, status: 'completed', diffs: [{ path: '/w/a.ts', oldText: '1', newText: '2' }] }),
      toolUpdate('c3', { first: true, status: 'completed', diffs: [{ path: '/w/b.ts', oldText: 'x', newText: 'y' }] })
    ]
    const edits = sessionEdits(events)
    expect([...edits.keys()]).toEqual(['/w/b.ts', '/w/a.ts'])
    expect(edits.get('/w/b.ts')?.length).toBe(2)
  })
})

describe('a file without the session’s edits', () => {
  test('fragment edits are undone newest first', async () => {
    const current = 'one\nTWO\nthree!\n'
    const edits = [
      { path: '/w/a', oldText: 'two', newText: 'TWO' },
      { path: '/w/a', oldText: 'three', newText: 'three!' }
    ]
    expect(await textWithoutEdits(current, edits, diffLines)).toBe('one\ntwo\nthree\n')
  })

  test('what the user typed beside the agent stays in', async () => {
    // The agent renamed `two`; the user then added a line of their own.
    const current = 'one\nTWO\nthree\nmine\n'
    const edits = [{ path: '/w/a', oldText: 'two', newText: 'TWO' }]
    expect(await textWithoutEdits(current, edits, diffLines)).toBe('one\ntwo\nthree\nmine\n')
  })

  test('a whole-file write the user edited afterwards is undone hunk by hunk', async () => {
    const before = 'a\nb\nc\nd\ne\nf\n'
    const written = 'a\nB\nc\nd\ne\nf\n'
    const current = 'a\nB\nc\nd\ne\nf\nmine\n'
    const edits = [{ path: '/w/a', oldText: before, newText: written }]
    expect(await textWithoutEdits(current, edits, diffLines)).toBe('a\nb\nc\nd\ne\nf\nmine\n')
  })

  test('a user line right beside the agent’s change survives, final newline or not', async () => {
    // As Claude reports a Write: the file whole, less its final newline.
    const edits = [
      {
        path: '/w/a',
        oldText: '# Demo\n\nA fixture project.',
        newText: '# Demo\n\nA sample project.\nAgent was here.'
      }
    ]
    const current = '# Demo\n\nA line the user added.\n\nA sample project.\nAgent was here.\n'
    expect(await textWithoutEdits(current, edits, diffLines)).toBe(
      '# Demo\n\nA line the user added.\n\nA fixture project.\n'
    )
  })

  test('lines the agent deleted go back after the line they followed', async () => {
    const edits = [{ path: '/w/a', oldText: 'a\nb\nc\nd\n', newText: 'a\nd\n' }]
    const current = 'top\na\nd\n'
    expect(await textWithoutEdits(current, edits, diffLines)).toBe('top\na\nb\nc\nd\n')
  })

  test('a line the user rewrote after the agent keeps the user’s version', async () => {
    const edits = [{ path: '/w/a', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nc\nD\n' }]
    const current = 'A\nb\nc\nD!\n'
    expect(await textWithoutEdits(current, edits, diffLines)).toBe('a\nb\nc\nD!\n')
  })

  test('a file the session created was empty before it', async () => {
    const edits = [
      { path: '/w/a', oldText: null, newText: 'x\n' },
      { path: '/w/a', oldText: 'x', newText: 'y' }
    ]
    expect(await textWithoutEdits('y\n', edits, diffLines)).toBe('')
  })

  test('an edit that can no longer be placed is left in', async () => {
    const edits = [{ path: '/w/a', oldText: 'two', newText: 'TWO' }]
    expect(await textWithoutEdits('one\nthree\n', edits, diffLines)).toBe('one\nthree\n')
  })
})

describe('paths inside the workspace', () => {
  test('relative to its root, or null outside it', () => {
    expect(relativeInside('/w', '/w/src/a.ts')).toBe('src/a.ts')
    expect(relativeInside('/w', 'src/a.ts')).toBe('src/a.ts')
    expect(relativeInside('/w', '/elsewhere/a.ts')).toBeNull()
    expect(relativeInside('/w', '/w')).toBeNull()
  })
})
