// Completion for the composer's `!` commands: which word the caret is on, what
// accepting a suggestion writes, and what bash offers for it.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeCompletion, applyCompletion } from '../src/renderer/src/lib/agents/completion'
import { completeShellWord, rankCandidates } from '../src/main/agents/shellCompletion'

describe('activeCompletion in a shell draft', () => {
  test('the first word completes as a command', () => {
    expect(activeCompletion('!gi', 3)).toEqual({ kind: 'shellCommand', query: 'gi', start: 1, end: 3 })
  })

  test('a private draft completes after its double marker', () => {
    expect(activeCompletion('!!ls', 4)).toEqual({ kind: 'shellCommand', query: 'ls', start: 2, end: 4 })
  })

  test('later words complete as paths', () => {
    expect(activeCompletion('!cat src/ma', 11)).toEqual({
      kind: 'shellPath',
      query: 'src/ma',
      start: 5,
      end: 11
    })
  })

  test('nothing is offered before a word is started', () => {
    expect(activeCompletion('!git ', 5)).toBeNull()
    expect(activeCompletion('!', 1)).toBeNull()
  })

  test('an @ inside a shell draft is a path, not a mention', () => {
    expect(activeCompletion('!echo @x', 8)?.kind).toBe('shellPath')
  })
})

describe('applyCompletion for shell words', () => {
  test('a command is followed by a space', () => {
    const completion = activeCompletion('!gi', 3)!
    expect(applyCompletion('!gi', completion, 'git')).toBe('!git ')
  })

  test('a directory is left open to complete into', () => {
    const completion = activeCompletion('!ls sr', 6)!
    expect(applyCompletion('!ls sr', completion, 'src/')).toBe('!ls src/')
  })

  test('text after the caret is kept', () => {
    const completion = activeCompletion('!gi status', 3)!
    expect(applyCompletion('!gi status', completion, 'git')).toBe('!git  status')
  })
})

describe('rankCandidates', () => {
  test('dedupes and puts the shortest first', () => {
    expect(rankCandidates('gitk\ngit\n\ngit\ngit-shell\n', 10)).toEqual(['git', 'gitk', 'git-shell'])
  })
})

describe('completeShellWord', () => {
  test('paths come from the directory the command runs in, directories slashed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'grove-complete-'))
    try {
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'setup.sh'), '')
      expect(await completeShellWord('s', 'argument', cwd)).toEqual(['src/', 'setup.sh'])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('commands include bash builtins', async () => {
    expect(await completeShellWord('ech', 'command', tmpdir())).toContain('echo')
  })

  test('the word is never run as code', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'grove-complete-'))
    try {
      await completeShellWord('$(touch pwned)', 'argument', cwd)
      expect(await completeShellWord('pw', 'argument', cwd)).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
