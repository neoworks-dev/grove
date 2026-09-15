// grove's editor handoff: the tool an agent calls to put files on screen.
//
// Two things matter here. The tool must never stop a turn on an approval — it
// only moves the editor — and it must survive whatever the model puts in its
// arguments, since a tool input is not validated before it arrives.

import { describe, expect, test } from 'bun:test'
import { groveTools } from '../src/main/agents/tools'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { OpenFileTarget } from '../src/shared/agents'
import { labelFor } from '../src/renderer/src/lib/agents/tools'

const CHANNEL = {
  post(): Promise<void> {
    return Promise.resolve()
  },
  list(): Promise<[]> {
    return Promise.resolve([])
  }
}

function openFilesTool(): GroveTool {
  const tool = groveTools({ chat: CHANNEL as never }).find((entry) => entry.name === 'open_files')
  if (!tool) throw new Error('open_files is not offered')
  return tool
}

/** A tool context that records what the tool asked the renderer to do. */
function recordingContext(): { context: GroveToolContext; opened: OpenFileTarget[][] } {
  const opened: OpenFileTarget[][] = []
  const context: GroveToolContext = {
    sessionId: 'session-1',
    workspaceRoot: '/repo',
    surface: () => {},
    openFiles: (files) => opened.push(files)
  }
  return { context, opened }
}

describe('open_files', () => {
  test('runs without an approval, so answering does not gate the editor', () => {
    expect(openFilesTool().policy).toBe('allow')
  })

  test('passes the files through in the order the agent gave them', async () => {
    const { context, opened } = recordingContext()
    const result = await openFilesTool().execute(
      { files: [{ path: 'src/a.ts', line: 12 }, { path: '/repo/src/b.ts' }] },
      context
    )

    expect(opened).toEqual([[{ path: 'src/a.ts', line: 12 }, { path: '/repo/src/b.ts' }]])
    expect(result.isError).toBeUndefined()
  })

  test('takes bare path strings, which is what a model reaches for', async () => {
    const { context, opened } = recordingContext()
    await openFilesTool().execute({ files: ['src/a.ts'] }, context)

    expect(opened).toEqual([[{ path: 'src/a.ts' }]])
  })

  test('drops entries with no usable path and lines that are not lines', async () => {
    const { context, opened } = recordingContext()
    await openFilesTool().execute(
      { files: [{ path: '' }, { line: 4 }, { path: 'src/a.ts', line: 0 }] },
      context
    )

    expect(opened).toEqual([[{ path: 'src/a.ts' }]])
  })

  test('reports an error rather than opening nothing silently', async () => {
    const { context, opened } = recordingContext()
    const result = await openFilesTool().execute({ files: [] }, context)

    expect(opened).toEqual([])
    expect(result.isError).toBe(true)
  })
})

describe('the transcript header for a call about several files', () => {
  test('reads as the files, not as the shape they arrived in', () => {
    const label = labelFor(undefined, {
      files: [{ path: 'src/a.ts', line: 3 }, { path: 'src/b.ts' }]
    })

    expect(label).toBe('src/a.ts, src/b.ts')
  })
})
