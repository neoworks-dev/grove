// A session's commands in its terminal view, and the preview under a running
// command's card.
//
// The view writes only what is new as output streams in, and starts over only
// when what it wrote no longer lines up; the preview shows each line as the
// terminal would have left it.

import { describe, expect, test } from 'bun:test'
import {
  planTerminalWrite,
  shellCommandsOf,
  type ShellCommand
} from '../src/renderer/src/lib/agents/shellTranscript'
import { outputTail } from '../src/renderer/src/lib/agents/outputTail'
import type { ToolItem, TranscriptItem } from '../src/renderer/src/lib/agents/transcript'

function call(toolUseId: string, name: string, command: string, result = ''): ToolItem {
  return {
    kind: 'tool',
    seq: 1,
    eventId: toolUseId,
    toolUseId,
    name,
    input: { command },
    editedInput: undefined,
    permission: 'allow',
    status: result ? 'ok' : 'running',
    progress: '',
    result,
    images: []
  }
}

function command(toolUseId: string, output: string, running = false): ShellCommand {
  return { toolUseId, command: toolUseId, output, running }
}

describe('the commands a session ran', () => {
  test('takes streamed output over the result, and skips other calls', () => {
    const items: TranscriptItem[] = [
      call('t1', 'Bash', 'ls', 'a\nb\n'),
      call('t2', 'Read', 'nope'),
      call('t3', 'Bash', 'bun test')
    ]

    const commands = shellCommandsOf(items, (item) => item.name === 'Bash', {
      t3: { text: 'running 4 tests\n', running: true }
    })

    expect(commands).toEqual([
      { toolUseId: 't1', command: 'ls', output: 'a\nb\n', running: false },
      { toolUseId: 't3', command: 'bun test', output: 'running 4 tests\n', running: true }
    ])
  })
})

describe('writing them to the terminal', () => {
  test('writes each command line, then its output', () => {
    const plan = planTerminalWrite([], [command('ls', 'a\n'), command('pwd', '/repo\n')])

    expect(plan.chunks).toEqual([
      '\u001b[2m$\u001b[0m \u001b[1mls\u001b[0m\n',
      'a\n',
      '\u001b[2m$\u001b[0m \u001b[1mpwd\u001b[0m\n',
      '/repo\n'
    ])
  })

  test('then writes only what the running command printed since', () => {
    const first = planTerminalWrite([], [command('ls', 'a\n'), command('make', 'cc a.c\n', true)])

    const next = planTerminalWrite(first.written, [
      command('ls', 'a\n'),
      command('make', 'cc a.c\ncc b.c\n', true)
    ])

    expect(next.reset).toBe(false)
    expect(next.chunks).toEqual(['cc b.c\n'])
  })

  test('starts a new command on its own line', () => {
    const first = planTerminalWrite([], [command('printf', 'no newline')])

    const next = planTerminalWrite(first.written, [
      command('printf', 'no newline'),
      command('ls', 'a\n')
    ])

    expect(next.chunks[0]).toBe('\n')
  })

  test('starts over when an earlier command changed under it', () => {
    const first = planTerminalWrite([], [command('bg', 'one\n'), command('ls', 'a\n')])

    const next = planTerminalWrite(first.written, [
      command('bg', 'one\ntwo\n'),
      command('ls', 'a\n')
    ])

    expect(next.reset).toBe(true)
    expect(next.chunks).toContain('one\ntwo\n')
  })
})

describe('the preview under a running command', () => {
  test('shows the last lines, without colour, as carriage returns left them', () => {
    const text = 'one\n\u001b[32mtwo\u001b[0m\n10%\r50%\r100%\nfour\n'

    expect(outputTail(text, 3)).toEqual(['two', '100%', 'four'])
  })
})
