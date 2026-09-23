// Folding runs of tool calls into one transcript row: what collapses, what is
// left alone, and how a run describes itself.

import { describe, expect, test } from 'bun:test'
import { tallyOf, toTranscriptRows } from '../src/renderer/src/lib/agents/toolRuns'
import type { ToolItem, TranscriptItem } from '../src/renderer/src/lib/agents/transcript'

let nextSeq = 0

function tool(name: string, status: ToolItem['status'] = 'ok'): ToolItem {
  nextSeq += 1
  return {
    kind: 'tool',
    seq: nextSeq,
    eventId: `evt_${nextSeq}`,
    toolUseId: `t${nextSeq}`,
    name,
    input: {},
    editedInput: undefined,
    permission: 'allow',
    status,
    progress: '',
    result: '',
    images: []
  }
}

function agent(text: string): TranscriptItem {
  nextSeq += 1
  return {
    kind: 'agent',
    seq: nextSeq,
    eventId: `evt_${nextSeq}`,
    thinking: '',
    text,
    streaming: false
  }
}

describe('tool runs', () => {
  test('folds consecutive settled calls into one row', () => {
    const rows = toTranscriptRows([tool('Read'), tool('Read'), tool('Bash')])

    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('toolRun')
  })

  test('leaves a lone call on its own line', () => {
    const rows = toTranscriptRows([tool('Read'), agent('done')])

    expect(rows.map((row) => row.kind)).toEqual(['item', 'item'])
  })

  test('a message between calls breaks the run', () => {
    const rows = toTranscriptRows([
      tool('Read'),
      tool('Read'),
      agent('now the edit'),
      tool('Edit'),
      tool('Edit')
    ])

    expect(rows.map((row) => row.kind)).toEqual(['toolRun', 'item', 'toolRun'])
  })

  test('a call that stands alone keeps its own row and breaks the run', () => {
    const isEdit = (call: ToolItem): boolean => call.name === 'Edit'
    const rows = toTranscriptRows(
      [tool('Read'), tool('Read'), tool('Edit'), tool('Edit'), tool('Read'), tool('Bash')],
      isEdit
    )

    expect(rows.map((row) => row.kind)).toEqual(['toolRun', 'item', 'item', 'toolRun'])
  })

  test('a call that is not settled stays visible on its own', () => {
    const rows = toTranscriptRows([
      tool('Read'),
      tool('Read'),
      tool('Bash', 'running'),
      tool('Write', 'pending'),
      tool('Edit', 'error')
    ])

    expect(rows.map((row) => row.kind)).toEqual(['toolRun', 'item', 'item', 'item'])
  })

  test('counts each tool name once, in the order it first appeared', () => {
    expect(tallyOf([tool('Read'), tool('Bash'), tool('Read'), tool('Read')])).toEqual([
      { name: 'Read', count: 3, files: [] },
      { name: 'Bash', count: 1, files: [] }
    ])
  })

  test('keeps the file each call was about, by name and once', () => {
    const paths: Record<string, string> = {}
    const first = tool('Read')
    const second = tool('Read')
    const again = tool('Read')
    paths[first.toolUseId] = '/repo/README.md'
    paths[second.toolUseId] = '/repo/src/index.ts'
    paths[again.toolUseId] = '/repo/README.md'

    const tallies = tallyOf([first, tool('Bash'), second, again], (item) => {
      return paths[item.toolUseId] ?? null
    })

    expect(tallies).toEqual([
      { name: 'Read', count: 3, files: ['README.md', 'index.ts'] },
      { name: 'Bash', count: 1, files: [] }
    ])
  })
})
