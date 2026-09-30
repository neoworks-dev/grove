// What a pending write would leave on disk, and grove mode's own file tools.
//
// The review flow diffs a pending write before it happens. Every harness now
// describes its writes the same way — ACP diffs on the permission request — so
// grove reads the change from the diff rather than modelling each harness's
// edit semantics. grove mode's read, edit and write produce those diffs
// themselves, and edit by hashline tags.

import { describe, expect, test } from 'bun:test'
import type { RequestPermissionRequest } from '@neoworks/harness'
import { writeOf } from '../src/main/agents/reviewBridge'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import { changedRegion, fileTools } from '../src/main/agents/tools/fileTools'
import { formatAnchor } from '../src/main/agents/tools/hashline/hash'
import {
  joinText,
  splitText,
  type FileText,
  type WorkspaceFiles
} from '../src/main/agents/tools/workspaceFiles'

/** A permission request carrying the given diffs. */
function requestWith(diffs: { path: string; oldText?: string | null; newText: string }[]): RequestPermissionRequest {
  return {
    sessionId: 'h1',
    toolCall: {
      toolCallId: 'c1',
      kind: 'edit',
      content: diffs.map((diff) => ({ type: 'diff' as const, ...diff }))
    },
    options: []
  }
}

describe('a pending write, read from its diffs', () => {
  test('a diff with no old text writes the file whole', () => {
    const write = writeOf(requestWith([{ path: '/w/a.ts', oldText: null, newText: 'next' }]))
    expect(write?.path).toBe('/w/a.ts')
    expect(write?.apply('previous')).toBe('next')
  })

  test('old text is replaced where it first occurs', () => {
    const write = writeOf(requestWith([{ path: '/w/a.ts', oldText: 'x', newText: 'y' }]))
    expect(write?.apply('x x x')).toBe('y x x')
  })

  test('diffs apply in order, each against the previous result', () => {
    const write = writeOf(
      requestWith([
        { path: '/w/a.ts', oldText: 'one', newText: 'two' },
        { path: '/w/a.ts', oldText: 'two', newText: 'three' }
      ])
    )
    expect(write?.apply('one')).toBe('three')
  })

  test('old text the file no longer has leaves the result unknown', () => {
    const write = writeOf(requestWith([{ path: '/w/a.ts', oldText: 'gone', newText: 'new' }]))
    expect(write?.apply('something else')).toBeNull()
  })

  test('a call that changes several files is left to the plain approval', () => {
    const request = requestWith([
      { path: '/w/a.ts', oldText: null, newText: 'a' },
      { path: '/w/b.ts', oldText: null, newText: 'b' }
    ])
    expect(writeOf(request)).toBeNull()
  })

  test('a call without a diff is not a write', () => {
    expect(writeOf(requestWith([]))).toBeNull()
  })
})

/** Files held in memory, keyed by absolute path. */
function memoryFiles(initial: Record<string, string>): WorkspaceFiles & { text(path: string): string | undefined } {
  const texts = new Map(Object.entries(initial))
  return {
    read(path): Promise<FileText> {
      const text = texts.get(path)
      if (text === undefined) {
        return Promise.resolve({ lines: [''], eol: '\n', finalNewline: true, exists: false, unsaved: false })
      }
      return Promise.resolve({ ...splitText(text), exists: true, unsaved: false })
    },
    write(path, read, lines) {
      texts.set(path, joinText(lines, read))
      return Promise.resolve()
    },
    text: (path) => texts.get(path)
  }
}

/** What a tool says its call would do; every file tool can say. */
function describeCall(tool: GroveTool, input: Record<string, unknown>): ReturnType<NonNullable<GroveTool['describe']>> {
  if (!tool.describe) throw new Error(`${tool.name} cannot describe its calls`)
  return tool.describe(input, context)
}

const context: GroveToolContext = {
  sessionId: 's1',
  workspaceRoot: '/w',
  surface: () => {},
  show: () => {}
}

/** One of the file tools by name. */
function toolNamed(files: WorkspaceFiles, name: string): GroveTool {
  const tool = fileTools(files).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

describe("grove mode's file tools", () => {
  test('read tags every line with its number and hash', async () => {
    const files = memoryFiles({ '/w/a.ts': 'const a = 1\nconst b = 2\n' })
    const result = await toolNamed(files, 'read').execute({ path: 'a.ts' }, context)
    expect(result.content).toBe(
      `${formatAnchor(1, 'const a = 1')}:const a = 1\n${formatAnchor(2, 'const b = 2')}:const b = 2`
    )
  })

  test('read says which lines it showed when it shows only some', async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\ntwo\nthree\n' })
    const result = await toolNamed(files, 'read').execute({ path: 'a.ts', offset: 2, limit: 1 }, context)
    expect(result.content).toBe(`${formatAnchor(2, 'two')}:two\n\n[Lines 2-2 of 3.]`)
  })

  test('edit replaces a tagged line, keeps the file ending, and shows fresh tags', async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\ntwo\nthree\n' })
    const edits = [{ op: 'replace', pos: formatAnchor(2, 'two'), lines: ['TWO'] }]
    const result = await toolNamed(files, 'edit').execute({ path: 'a.ts', edits }, context)

    expect(files.text('/w/a.ts')).toBe('one\nTWO\nthree\n')
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain(`${formatAnchor(2, 'TWO')}:TWO`)
  })

  test('edit against a stale tag changes nothing and says so', async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\nrewritten\nthree\n' })
    const edits = [{ op: 'replace', pos: formatAnchor(2, 'two'), lines: ['TWO'] }]
    const result = await toolNamed(files, 'edit').execute({ path: 'a.ts', edits }, context)

    expect(result.isError).toBe(true)
    expect(files.text('/w/a.ts')).toBe('one\nrewritten\nthree\n')
  })

  test("edit describes itself as the diff it would make, for the review", async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\ntwo\n' })
    const edits = [{ op: 'append', pos: formatAnchor(1, 'one'), lines: ['one and a half'] }]
    const described = await describeCall(toolNamed(files, 'edit'), { path: 'a.ts', edits })

    expect(described.kind).toBe('edit')
    expect(described.content).toEqual([
      { type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\none and a half\ntwo\n' }
    ])
    expect(described.locations).toEqual([{ path: '/w/a.ts', line: 2 }])
  })

  test('edit reports its diff onto the call, so the transcript keeps it', async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\n' })
    const reported: unknown[] = []
    const edits = [{ op: 'replace', pos: formatAnchor(1, 'one'), lines: ['uno'] }]
    await toolNamed(files, 'edit').execute(
      { path: 'a.ts', edits },
      { ...context, report: (update) => reported.push(update) }
    )
    expect(reported).toHaveLength(1)
    expect((reported[0] as { content: unknown[] }).content[0]).toEqual({
      type: 'diff',
      path: '/w/a.ts',
      oldText: 'one\n',
      newText: 'uno\n'
    })
  })

  test('the same edit changing nothing three times over is stopped', async () => {
    const files = memoryFiles({ '/w/a.ts': 'one\n' })
    const edit = toolNamed(files, 'edit')
    const input = { path: 'a.ts', edits: [{ op: 'replace', pos: formatAnchor(1, 'one'), lines: ['one'] }] }
    await edit.execute(input, context)
    await edit.execute(input, context)
    const third = await edit.execute(input, context)
    expect(third.isError).toBe(true)
    expect(third.content).toContain('STOP')
  })

  test('write creates a file, and its diff has no old text', async () => {
    const files = memoryFiles({})
    const write = toolNamed(files, 'write')
    const described = await describeCall(write, { path: 'new.ts', content: 'x\n' })
    const result = await write.execute({ path: 'new.ts', content: 'x\n' }, context)

    expect(files.text('/w/new.ts')).toBe('x\n')
    expect(result.content).toBe('Created new.ts (1 lines).')
    expect(described.content).toEqual([{ type: 'diff', path: '/w/new.ts', oldText: null, newText: 'x\n' }])
  })
})

describe('the lines an edit changed', () => {
  test('a replaced line', () => {
    expect(changedRegion(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({ first: 2, last: 2 })
  })

  test('inserted lines', () => {
    expect(changedRegion(['a', 'c'], ['a', 'b1', 'b2', 'c'])).toEqual({ first: 2, last: 3 })
  })

  test('a deletion points at where it happened', () => {
    expect(changedRegion(['a', 'b', 'c'], ['a', 'c'])).toEqual({ first: 2, last: 2 })
  })

  test('no change', () => {
    expect(changedRegion(['a'], ['a'])).toBeNull()
  })
})
