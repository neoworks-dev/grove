// Completion for the composer's `!` commands: which word the caret is on, what
// accepting a suggestion writes, and what the user's shell offers for it.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeCompletion, applyCompletion } from '../src/renderer/src/lib/agents/completion'
import {
  completeShellLine,
  lastWord,
  parseFishCompletions,
  rankCandidates
} from '../src/main/agents/shellCompletion'
import { resolveLoginShell } from '../src/main/agents/loginShell'

const bash = { path: '/bin/bash', name: 'bash' }
const fish = { path: 'fish', name: 'fish' }

/** Whether a program is on PATH, so shell-specific tests skip where it is not. */
function installed(program: string): boolean {
  try {
    execFileSync('which', [program], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function inTempDir<T>(use: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'grove-complete-'))
  try {
    return await use(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('activeCompletion in a shell draft', () => {
  test('the word the caret ends is completed, with the line so far', () => {
    expect(activeCompletion('!git chec', 9)).toEqual({
      kind: 'shell',
      query: 'chec',
      start: 5,
      end: 9,
      line: 'git chec'
    })
  })

  test('a private draft completes after its double marker', () => {
    expect(activeCompletion('!!ls', 4)?.line).toBe('ls')
  })

  test('nothing is offered for an unstarted word unless Tab asked', () => {
    expect(activeCompletion('!git ', 5)).toBeNull()
    expect(activeCompletion('!git ', 5, true)).toEqual({
      kind: 'shell',
      query: '',
      start: 5,
      end: 5,
      line: 'git '
    })
  })

  test('an @ inside a shell draft is a shell word, not a mention', () => {
    expect(activeCompletion('!echo @x', 8)?.kind).toBe('shell')
  })
})

describe('applyCompletion for shell words', () => {
  test('a word is followed by a space', () => {
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

describe('parsing', () => {
  test('rankCandidates dedupes and puts the shortest first', () => {
    expect(rankCandidates('gitk\ngit\n\ngit\ngit-shell\n', 10)).toEqual(['git', 'gitk', 'git-shell'])
  })

  test('parseFishCompletions splits descriptions and keeps fish order', () => {
    expect(parseFishCompletions('checkout\tSwitch branches\ncherry\ncheckout\tagain\n')).toEqual([
      { value: 'checkout', description: 'Switch branches' },
      { value: 'cherry' }
    ])
  })

  test('lastWord is what follows the last space', () => {
    expect(lastWord('git chec')).toBe('chec')
    expect(lastWord('git ')).toBe('')
  })
})

describe('resolveLoginShell', () => {
  test('the passwd entry wins over an inherited $SHELL', () => {
    expect(resolveLoginShell({ SHELL: '/bin/bash' }, '/bin/sh')).toEqual({ path: '/bin/sh', name: 'sh' })
  })

  test('$SHELL is used when the account names no shell', () => {
    expect(resolveLoginShell({ SHELL: '/bin/sh' }, null).path).toBe('/bin/sh')
  })

  test('falls back to /bin/sh when nothing points at a shell', () => {
    expect(resolveLoginShell({}, null).path).toBe('/bin/sh')
    expect(resolveLoginShell({ SHELL: '/nowhere/zsh' }, '/nowhere/fish').path).toBe('/bin/sh')
  })
})

describe('completeShellLine with bash', () => {
  test('paths come from the directory the command runs in, directories slashed', async () => {
    await inTempDir(async (cwd) => {
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'setup.sh'), '')
      const completions = await completeShellLine('ls s', bash, cwd)
      expect(completions.map((completion) => completion.value)).toEqual(['src/', 'setup.sh'])
    })
  })

  test('the first word completes as a command', async () => {
    const completions = await completeShellLine('ech', bash, tmpdir())
    expect(completions.map((completion) => completion.value)).toContain('echo')
  })

  test('the word is never run as code', async () => {
    await inTempDir(async (cwd) => {
      await completeShellLine('ls $(touch pwned)', bash, cwd)
      expect(await completeShellLine('ls pw', bash, cwd)).toEqual([])
    })
  })
})

describe.if(installed('fish'))('completeShellLine with fish', () => {
  test('subcommands come with their descriptions', async () => {
    const completions = await completeShellLine('git chec', fish, tmpdir())
    const checkout = completions.find((completion) => completion.value === 'checkout')
    expect(checkout?.description).toBeTruthy()
  })

  test('the line is never run as code', async () => {
    await inTempDir(async (cwd) => {
      await completeShellLine('ls (touch pwned)', fish, cwd)
      await completeShellLine('ls $(touch pwned2)', fish, cwd)
      expect(await completeShellLine('ls pw', fish, cwd)).toEqual([])
    })
  })
})
