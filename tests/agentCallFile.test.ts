// Which calls are about a file. Follow mode and the clickable header both hang on
// this, and it has to work without knowing what a harness named its arguments.

import { describe, expect, test } from 'bun:test'
import { fileOfCall } from '../src/renderer/src/lib/agents/tools'
import type { ToolDisplay } from '../src/renderer/src/lib/agents/types'

const ROOT = '/home/dev/project'

const filePathDisplay: ToolDisplay = { label: '{file_path}', input: 'code', result: 'text' }
const commandDisplay: ToolDisplay = { label: '{command}', input: 'command', result: 'text' }

describe('fileOfCall', () => {
  test('reads the path out of whatever field the label names', () => {
    const input = { file_path: `${ROOT}/src/app.ts`, content: 'x' }
    expect(fileOfCall(filePathDisplay, input, ROOT)).toBe(`${ROOT}/src/app.ts`)
  })

  test('falls back to a `path` field when the tool ships no label', () => {
    expect(fileOfCall(undefined, { path: 'src/app.ts' }, ROOT)).toBe('src/app.ts')
  })

  test('a command is not a path, however single-token it looks', () => {
    expect(fileOfCall(commandDisplay, { command: 'build.sh' }, ROOT)).toBeNull()
  })

  test('a sentence or a glob is not a path', () => {
    expect(fileOfCall(undefined, { query: 'find the theme tokens' }, ROOT)).toBeNull()
    expect(fileOfCall(undefined, { pattern: 'src/**/*.ts' }, ROOT)).toBeNull()
  })
})
