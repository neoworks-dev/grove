// Fix with agent: what an agent is told about a diagnostic or a failed command,
// and how a failed command is read back out of the terminal it ran in.

import { describe, expect, test } from 'bun:test'
import {
  fenced,
  fixMessage,
  severityName,
  surroundingCode
} from '../src/renderer/src/lib/agents/fixPrompt'
import {
  MAX_OUTPUT_LINES,
  commandFromMarker,
  commandOutput,
  readLines,
  typedCommand,
  type BufferLike
} from '../src/renderer/src/lib/terminalCommands'

/** A terminal buffer holding these lines; a line starting with `↪` continues the one before. */
function bufferOf(lines: string[]): BufferLike {
  return {
    getLine(y: number) {
      const text = lines[y]
      if (text === undefined) {
        return undefined
      }
      const isWrapped = text.startsWith('↪')
      return {
        isWrapped,
        translateToString: () => text.replace(/^↪/, '')
      }
    }
  }
}

describe('diagnostic message', () => {
  test('names the file, position, severity and source, and attaches the code', () => {
    const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
    const blocks = fixMessage({
      kind: 'diagnostic',
      path: 'src/app.ts',
      diagnostics: [
        { line: 20, column: 5, severity: 'error', message: "Cannot find name 'x'.", source: 'ts' }
      ],
      code: surroundingCode(content, 20)
    })

    expect(blocks[0]).toEqual({
      type: 'text',
      text: "Fix the problem reported in src/app.ts:\n\n- src/app.ts:20:5 error (ts): Cannot find name 'x'."
    })
    expect(blocks[1]).toEqual({
      type: 'file',
      path: 'src/app.ts',
      startLine: 10,
      endLine: 30,
      text: content.split('\n').slice(9, 30).join('\n')
    })
  })

  test('lists every diagnostic on the line, and goes without code it could not read', () => {
    const blocks = fixMessage({
      kind: 'diagnostic',
      path: 'a.ts',
      diagnostics: [
        { line: 1, column: 1, severity: 'error', message: 'first' },
        { line: 1, column: 9, severity: 'warning', message: 'second', source: 'eslint' }
      ],
      code: null
    })

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'Fix the problems reported in a.ts:\n\n- a.ts:1:1 error: first\n- a.ts:1:9 warning (eslint): second'
      }
    ])
  })

  test('code around a line stops at the ends of the file', () => {
    expect(surroundingCode('a\nb\nc', 1, 10)).toEqual({ startLine: 1, endLine: 3, text: 'a\nb\nc' })
    expect(surroundingCode('a\nb\n', 2, 10)).toEqual({ startLine: 1, endLine: 2, text: 'a\nb' })
  })

  test('severities read as words', () => {
    expect([1, 2, 3, 4, 9].map(severityName)).toEqual(['error', 'warning', 'info', 'hint', 'hint'])
  })
})

describe('failed command message', () => {
  test('carries the command, its exit code and its output', () => {
    const blocks = fixMessage({
      kind: 'command',
      command: 'bun test',
      exitCode: 1,
      output: 'expected 1, got 2\n'
    })

    expect(blocks).toEqual([
      {
        type: 'text',
        text: [
          'This command failed in my terminal with exit code 1. Find out why and fix it.',
          '',
          '```console',
          '$ bun test',
          'expected 1, got 2',
          '```'
        ].join('\n')
      }
    ])
  })

  test('output holding a fence gets a longer one', () => {
    expect(fenced('a ``` b')).toBe('````\na ``` b\n````')
  })
})

describe('reading a command from the terminal', () => {
  test('fish sends the command line URL-encoded with the C marker', () => {
    expect(commandFromMarker('C;cmdline_url=bun%20test%20%3B%20echo%20done')).toBe(
      'bun test ; echo done'
    )
  })

  test('kitty sends it plain, semicolons and all', () => {
    expect(commandFromMarker('C;cmdline=make; echo done')).toBe('make; echo done')
  })

  test('a C marker without one carries none', () => {
    expect(commandFromMarker('C')).toBeNull()
  })

  test('without one, the command is what was typed after the prompt', () => {
    const buffer = bufferOf(['~/repo> bun run build --wat', '↪ch', 'error: bad flag'])
    expect(typedCommand(buffer, { line: 0, column: 8 }, 2)).toBe('bun run build --watch')
  })

  test('output joins wrapped lines and drops the blank ones after it', () => {
    const buffer = bufferOf(['$ make', 'error: a very long', '↪ line', '', ''])
    expect(readLines(buffer, 1, 4)).toEqual(['error: a very long line'])
  })

  test('long output keeps its end', () => {
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, index) => `out ${index}`)
    const output = commandOutput(bufferOf(lines), 0, lines.length - 1).split('\n')

    expect(output[0]).toBe('… 50 earlier lines')
    expect(output.length).toBe(MAX_OUTPUT_LINES + 1)
    expect(output[output.length - 1]).toBe(`out ${MAX_OUTPUT_LINES + 49}`)
  })
})
