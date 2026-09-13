// How a tool call names itself in the transcript: the file a call is about, split
// into the name and the directory behind it, and the description a call carries.

import { describe, expect, test } from 'bun:test'
import { descriptionOf, pathLabelOf } from '../src/renderer/src/lib/agents/tools'

const ROOT = '/home/moritz/Documents/grove'

describe('pathLabelOf', () => {
  test('splits an absolute path into its name and its directory', () => {
    expect(pathLabelOf('/tmp/notes/todo.md', '')).toEqual({
      directory: '/tmp/notes/',
      name: 'todo.md'
    })
  })

  test('drops the workspace prefix, which every row would otherwise repeat', () => {
    expect(pathLabelOf(`${ROOT}/src/main/index.ts`, ROOT)).toEqual({
      directory: 'src/main/',
      name: 'index.ts'
    })
  })

  test('a file at the workspace root has no directory left', () => {
    expect(pathLabelOf(`${ROOT}/package.json`, ROOT)).toEqual({
      directory: '',
      name: 'package.json'
    })
  })

  test('a path outside the workspace keeps it', () => {
    expect(pathLabelOf('/etc/hosts', ROOT)).toEqual({ directory: '/etc/', name: 'hosts' })
  })

  test('a bare file name is still a path', () => {
    expect(pathLabelOf('README.md', ROOT)).toEqual({ directory: '', name: 'README.md' })
  })

  test('commands, sentences and globs are not paths', () => {
    expect(pathLabelOf('bunx prettier --check README.md', ROOT)).toBeNull()
    expect(pathLabelOf('src/**/*.ts', ROOT)).toBeNull()
    expect(pathLabelOf('grep', ROOT)).toBeNull()
    expect(pathLabelOf('', ROOT)).toBeNull()
  })
})

describe('descriptionOf', () => {
  test('reads the description a call carries beside its arguments', () => {
    expect(descriptionOf({ command: 'bun test', description: ' Run the tests ' })).toBe(
      'Run the tests'
    )
  })

  test('is empty when the call has none', () => {
    expect(descriptionOf({ command: 'bun test' })).toBe('')
    expect(descriptionOf({ description: 7 })).toBe('')
    expect(descriptionOf('bun test')).toBe('')
  })
})
