// A session's commands in its terminal view, and the preview under a running
// command's card.
//
// The view writes only what is new as output streams in, and starts over only
// when what it wrote no longer lines up; the preview shows each line as the
// terminal would have left it.

import { describe, expect, test } from 'bun:test'
import {
  ansiOfTokens,
  planTerminalWrite,
  shellCommandsOf,
  type ShellCommand
} from '../src/renderer/src/lib/agents/shellTranscript'
import { outputTail } from '../src/renderer/src/lib/agents/outputTail'
import {
  applyEvent,
  createTranscript,
  visibleItems,
  type ToolItem,
  type TranscriptItem
} from '../src/renderer/src/lib/agents/transcript'
import type { EventBody } from '../src/renderer/src/lib/agents/types'

function call(
  toolUseId: string,
  name: string,
  command: string,
  result = '',
  status: ToolItem['status'] = result ? 'ok' : 'running'
): ToolItem {
  return {
    kind: 'tool',
    seq: 1,
    eventId: toolUseId,
    toolUseId,
    name,
    input: { command },
    editedInput: undefined,
    permission: 'allow',
    status,
    progress: '',
    result,
    rawResult: '',
    images: []
  }
}

function command(toolUseId: string, output: string, running = false): ShellCommand {
  return { toolUseId, command: toolUseId, output, running, finished: !running }
}

describe("the user's own terminal commands", () => {
  test('stay out of the agent tab, which would only show them twice', () => {
    const items = [
      { kind: 'shell', shellId: 'a', command: 'ls', output: 'x', running: false, exitCode: 0, fromTerminal: true },
      { kind: 'shell', shellId: 'b', command: 'pwd', output: '/', running: false, exitCode: 0, fromTerminal: false }
    ] as unknown as Parameters<typeof shellCommandsOf>[0]
    expect(shellCommandsOf(items, () => true, {}).map((command) => command.command)).toEqual(['pwd'])
  })
})

describe('the preview of a command in a terminal', () => {
  test('drops what a shell sends a terminal on start, not just colour', () => {
    const started = '\u001b[?u\u001b[>0q\u001b]11;?\u001b\\\u001bP+q696e646e\u001b\\\u001b[?1049h\u001b=\u001b(BContinue? '
    expect(outputTail(started, 3)).toEqual(['Continue? '])
  })
})

describe('the commands a session ran', () => {
  test('takes streamed output over the result, and skips other calls', () => {
    const items: TranscriptItem[] = [
      call('t1', 'Bash', 'ls', 'a\nb\n'),
      call('t2', 'Read', 'nope'),
      call('t3', 'Bash', 'bun test')
    ]

    const commands = shellCommandsOf(items, (item) => item.name === 'Bash', {
      t3: { text: 'running 4 tests\n', running: true, background: false }
    })

    expect(commands).toEqual([
      { toolUseId: 't1', command: 'ls', output: 'a\nb\n', running: false, finished: true },
      {
        toolUseId: 't3',
        command: 'bun test',
        output: 'running 4 tests\n',
        running: true,
        finished: false
      }
    ])
  })
})

describe('how a command ended', () => {
  test('a failed call carries the exit code its result names', () => {
    const items: TranscriptItem[] = [
      call('t1', 'shell', 'ls nope', 'ls: nope\n[Exit code 2.]', 'error'),
      call('t2', 'Bash', 'false', 'Exit code 1', 'error'),
      call('t3', 'shell', 'sleep 9', '[Killed by SIGINT.]', 'error'),
      call('t4', 'shell', 'ls', 'a\n')
    ]

    const failures = shellCommandsOf(items, () => true, {}).map((each) => each.failure)

    expect(failures).toEqual([{ exitCode: 2 }, { exitCode: 1 }, { exitCode: null }, undefined])
  })
})

/**
 * A grove shell call that failed, folded the way Claude Code's ACP adapter
 * reports it: the text content fenced for display, the plain text as rawOutput.
 */
function reloadedFailedShellCall(rawOutput: unknown): TranscriptItem[] {
  const bodies: EventBody[] = [
    {
      type: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'mcp__grove__shell',
        status: 'in_progress',
        rawInput: { command: 'ls nope' },
        _meta: { claudeCode: { toolName: 'mcp__grove__shell' } }
      }
    } as EventBody,
    {
      type: 'update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: '```\nls: nope\n[Exit code 2.]\n```' } }
        ],
        rawOutput
      }
    } as EventBody
  ]
  const state = createTranscript()
  for (const [index, body] of bodies.entries()) {
    applyEvent(state, {
      ...body,
      id: `evt_${index + 1}`,
      seq: index + 1,
      sessionId: 's1',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
  }
  return visibleItems(state)
}

describe('a reloaded session, without its streamed output', () => {
  test('shows a failed call as it printed, not as the model was shown it', () => {
    for (const rawOutput of [
      'ls: nope\n[Exit code 2.]',
      [{ type: 'text', text: 'ls: nope\n[Exit code 2.]' }]
    ]) {
      const commands = shellCommandsOf(
        reloadedFailedShellCall(rawOutput),
        (item) => item.name === 'shell',
        {}
      )

      expect(commands).toEqual([
        {
          toolUseId: 't1',
          command: 'ls nope',
          output: 'ls: nope',
          running: false,
          finished: true,
          failure: { exitCode: 2 }
        }
      ])
      expect(planTerminalWrite([], commands).chunks.join('')).toBe(
        '\u001b[32m❯\u001b[0m \u001b[1mls nope\u001b[0m\nls: nope\n\u001b[31m✗ exit 2\u001b[0m\n'
      )
    }
  })
})

describe('writing them to the terminal', () => {
  test('shows each command line as the painter colours it', () => {
    const plan = planTerminalWrite([], [command('ls', 'a\n')], (line) => `<${line}>`)

    expect(plan.chunks[0]).toBe('\u001b[32m❯\u001b[0m <ls>\n')
  })

  test('turns highlighted tokens into 24-bit colour escapes', () => {
    const lines = [
      [
        { text: 'echo', color: '#89b4fa' },
        { text: ' hi', color: '' }
      ],
      [{ text: 'ls', color: '#A6E3A1FF' }]
    ]

    expect(ansiOfTokens(lines)).toBe(
      '\u001b[38;2;137;180;250mecho\u001b[39m hi\n\u001b[38;2;166;227;161mls\u001b[39m'
    )
  })

  test('writes each command line, then its output, with a blank line before the next', () => {
    const plan = planTerminalWrite([], [command('ls', 'a\n'), command('pwd', '/repo\n')])

    expect(plan.chunks).toEqual([
      '\u001b[32m❯\u001b[0m \u001b[1mls\u001b[0m\n',
      'a\n',
      '\n',
      '\u001b[32m❯\u001b[0m \u001b[1mpwd\u001b[0m\n',
      '/repo\n'
    ])
  })

  test('marks a failed command with its exit status once it ends', () => {
    const running = planTerminalWrite([], [command('ls nope', 'ls: nope\n', true)])
    const failed: ShellCommand = {
      ...command('ls nope', 'ls: nope\n'),
      failure: { exitCode: 2 }
    }

    const ended = planTerminalWrite(running.written, [failed])

    expect(ended.reset).toBe(false)
    expect(ended.chunks).toEqual(['\u001b[31m✗ exit 2\u001b[0m\n'])
    expect(planTerminalWrite(ended.written, [failed]).chunks).toEqual([])
  })

  test('waits for the result, not the end of the stream, to say how it ended', () => {
    const streamEnded: ShellCommand = { ...command('cat x', 'cat: x\n'), finished: false }
    const first = planTerminalWrite([], [streamEnded])

    const next = planTerminalWrite(first.written, [
      { ...streamEnded, finished: true, failure: { exitCode: 1 } }
    ])

    expect(first.chunks.join('')).not.toContain('✗')
    expect(next.chunks).toEqual(['\u001b[31m✗ exit 1\u001b[0m\n'])
  })

  test('holds a call back until its command line has arrived', () => {
    const first = planTerminalWrite(
      [],
      [command('ls', 'a\n'), { ...command('t2', '', true), command: '' }]
    )

    const next = planTerminalWrite(first.written, [command('ls', 'a\n'), command('t2', '', true)])

    expect(first.written).toHaveLength(1)
    expect(next.reset).toBe(false)
    expect(next.chunks.join('')).toContain('t2')
  })

  test('marks nothing for a command that succeeded', () => {
    const plan = planTerminalWrite([], [command('ls', 'a\n')])

    expect(plan.chunks.join('')).not.toContain('✗')
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

    expect(next.chunks[0]).toBe('\n\n')
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
