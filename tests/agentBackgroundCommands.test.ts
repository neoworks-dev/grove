// The background commands the composer lists for the user to stop.

import { describe, expect, test } from 'bun:test'
import { backgroundCommandsOf } from '../src/renderer/src/lib/agents/backgroundCommands'
import type { TranscriptItem } from '../src/renderer/src/lib/agents/transcript'

/** A shell tool call, as the transcript folds one. */
function toolCall(toolUseId: string, command: string): TranscriptItem {
  return {
    kind: 'tool',
    toolUseId,
    name: 'shell',
    title: command,
    input: { command }
  } as unknown as TranscriptItem
}

/** A `!` run, as the transcript folds one. */
function shellRun(shellId: string, command: string): TranscriptItem {
  return { kind: 'shell', shellId, command, running: true } as unknown as TranscriptItem
}

describe('background commands', () => {
  test('lists running commands nothing waits on, with their command lines', () => {
    const items = [toolCall('t1', 'bun run dev'), shellRun('evt_2', 'tail -f log'), toolCall('t3', 'ls')]
    const live = {
      t1: { text: '', running: true, background: true },
      evt_2: { text: '', running: true, background: true },
      t3: { text: '', running: true, background: false }
    }

    expect(backgroundCommandsOf(items, live)).toEqual([
      { id: 't1', command: 'bun run dev' },
      { id: 'evt_2', command: 'tail -f log' }
    ])
  })

  test('drops one once it has exited', () => {
    const items = [toolCall('t1', 'bun run dev')]
    const live = { t1: { text: '', running: false, background: true } }

    expect(backgroundCommandsOf(items, live)).toEqual([])
  })
})
