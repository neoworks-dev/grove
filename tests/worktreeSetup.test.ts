// Creating a worktree is two steps: checking it out, which a caller waits on,
// and running its setup, which may take minutes and runs only what
// grove.config.yaml lists — no install guessed from a lockfile — and only once
// the user has trusted those commands.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appStub, electronStub } from './electronStub'

mock.module('electron', () => electronStub)

const { addWorktree, setupWorktree } = await import('../src/main/worktrees')
const { applyDefaults } = await import('../src/main/config')

let root: string

/** Answers every trust prompt with yes. */
const trustAll = async (): Promise<boolean> => true

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grove-setup-'))
  const userData = join(root, 'userData')
  mkdirSync(userData)
  appStub.getPath = () => userData
})

afterEach(() => {
  appStub.getPath = () => process.cwd()
  rmSync(root, { recursive: true, force: true })
})

/** A committed JavaScript repo, lockfile and all, so an install would have something to guess from. */
function javascriptRepo(): string {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'package.json'), '{"name":"demo"}')
  writeFileSync(join(repo, 'bun.lock'), '')
  execSync(
    'git init -q -b main && git add . && git -c user.name=t -c user.email=t@t commit -q -m init',
    { cwd: repo }
  )
  return repo
}

describe('addWorktree', () => {
  it('checks the worktree out without running any setup', async () => {
    const repo = javascriptRepo()
    const config = applyDefaults({ setup: { per_worktree: ['touch per-worktree-ran'] } })

    const created = await addWorktree(repo, config, { name: 'feature', newBranch: 'feature' })

    expect(existsSync(join(created.path, 'package.json'))).toBe(true)
    expect(existsSync(join(created.path, 'per-worktree-ran'))).toBe(false)
  })
})

describe('setupWorktree', () => {
  it('runs the configured commands and nothing else', async () => {
    const repo = javascriptRepo()
    const config = applyDefaults({
      setup: { once: ['touch once-ran'], per_worktree: ['touch per-worktree-ran'] }
    })
    const created = await addWorktree(repo, config, { name: 'feature', newBranch: 'feature' })
    const lines: string[] = []

    const succeeded = await setupWorktree(
      repo,
      config,
      created,
      (_id, line) => lines.push(line),
      trustAll
    )

    expect(succeeded).toBe(true)
    expect(existsSync(join(created.path, 'once-ran'))).toBe(true)
    expect(existsSync(join(created.path, 'per-worktree-ran'))).toBe(true)
    expect(existsSync(join(created.path, 'node_modules'))).toBe(false)
    expect(lines.some((line) => line.includes('install'))).toBe(false)
  })

  it('reports a failing command, and still runs the ones after it', async () => {
    const repo = javascriptRepo()
    const config = applyDefaults({ setup: { per_worktree: ['exit 3', 'touch after-failure'] } })
    const created = await addWorktree(repo, config, { name: 'feature', newBranch: 'feature' })

    const succeeded = await setupWorktree(repo, config, created, () => {}, trustAll)

    expect(succeeded).toBe(false)
    expect(existsSync(join(created.path, 'after-failure'))).toBe(true)
  })
})

describe('setup trust', () => {
  it('runs nothing when the user does not trust the commands', async () => {
    const repo = javascriptRepo()
    const config = applyDefaults({
      setup: { once: ['touch once-ran'], per_worktree: ['touch per-worktree-ran'] }
    })
    const created = await addWorktree(repo, config, { name: 'feature', newBranch: 'feature' })
    const asked: string[][] = []

    await setupWorktree(
      repo,
      config,
      created,
      () => {},
      async (commands) => {
        asked.push(commands)
        return false
      }
    )

    expect(asked).toEqual([['touch once-ran', 'touch per-worktree-ran']])
    expect(existsSync(join(created.path, 'once-ran'))).toBe(false)
    expect(existsSync(join(created.path, 'per-worktree-ran'))).toBe(false)
  })

  it('asks once for the same commands, and again when they change', async () => {
    const repo = javascriptRepo()
    const config = applyDefaults({ setup: { per_worktree: ['touch ran'] } })
    let prompts = 0
    const countingTrust = async (): Promise<boolean> => {
      prompts += 1
      return true
    }

    const first = await addWorktree(repo, config, { name: 'one', newBranch: 'one' })
    await setupWorktree(repo, config, first, () => {}, countingTrust)
    const second = await addWorktree(repo, config, { name: 'two', newBranch: 'two' })
    await setupWorktree(repo, config, second, () => {}, countingTrust)
    expect(prompts).toBe(1)
    expect(existsSync(join(second.path, 'ran'))).toBe(true)

    const changed = applyDefaults({ setup: { per_worktree: ['touch ran', 'touch more'] } })
    const third = await addWorktree(repo, changed, { name: 'three', newBranch: 'three' })
    await setupWorktree(repo, changed, third, () => {}, countingTrust)
    expect(prompts).toBe(2)
  })
})

describe('setup variables', () => {
  it('passes a branch name as data, never as shell syntax', async () => {
    const repo = javascriptRepo()
    const branch = 'x;touch${IFS}injected'
    const config = applyDefaults({ setup: { per_worktree: ['echo "$WT_BRANCH" > branch.txt'] } })
    const created = await addWorktree(repo, config, { name: 'feature', newBranch: branch })

    await setupWorktree(repo, config, created, () => {}, trustAll)

    expect(existsSync(join(created.path, 'injected'))).toBe(false)
    expect(readFileSync(join(created.path, 'branch.txt'), 'utf8').trim()).toBe(branch)
  })
})
