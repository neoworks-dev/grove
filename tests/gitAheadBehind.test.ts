// How far a worktree's branch is from the base branch, as its row shows it.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { aheadBehind, branchHasMoved } from '../src/main/git'

let repo: string

/** Runs a git command in the test repo. */
function git(command: string): void {
  execSync(`git -c user.name=t -c user.email=t@t ${command}`, { cwd: repo })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'grove-ahead-behind-'))
  execSync('git init -q -b main', { cwd: repo })
  git('commit -q --allow-empty -m base')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('aheadBehind', () => {
  it('counts the branch commits and the base commits apart', async () => {
    git('switch -q -c feature')
    git('commit -q --allow-empty -m one')
    git('commit -q --allow-empty -m two')
    git('switch -q main')
    git('commit -q --allow-empty -m moved-on')
    git('switch -q feature')
    expect(await aheadBehind(repo, 'main')).toEqual({ ahead: 2, behind: 1 })
  })

  it('is null when the base does not resolve', async () => {
    expect(await aheadBehind(repo, 'no-such-branch')).toBeNull()
  })
})

describe('branchHasMoved', () => {
  it('is false for a branch that was only created, true once it is committed to', async () => {
    git('branch fresh')
    expect(await branchHasMoved(repo, 'fresh')).toBe(false)
    git('switch -q fresh')
    git('commit -q --allow-empty -m work')
    expect(await branchHasMoved(repo, 'fresh')).toBe(true)
  })

  it('is false for a branch that does not exist', async () => {
    expect(await branchHasMoved(repo, 'missing')).toBe(false)
  })
})
