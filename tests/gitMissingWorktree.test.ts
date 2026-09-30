// A worktree whose directory was deleted without `git worktree remove` is still
// listed by git until it is pruned. It must not make the whole repo unopenable.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listWorktrees } from '../src/main/git'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'grove-missing-wt-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A repo with one commit and a second worktree whose directory has been deleted. */
function repoWithDeletedWorktree(): { repo: string; deleted: string } {
  const repo = join(root, 'repo')
  const deleted = join(root, 'gone')
  execSync(`git init -q -b main ${repo}`)
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  execSync('git add . && git -c user.name=t -c user.email=t@t commit -q -m init', { cwd: repo })
  execSync(`git worktree add -q -b gone ${deleted}`, { cwd: repo })
  rmSync(deleted, { recursive: true, force: true })
  return { repo, deleted }
}

describe('listWorktrees', () => {
  it('lists the rest of the worktrees when one directory is gone', async () => {
    const { repo, deleted } = repoWithDeletedWorktree()

    const worktrees = await listWorktrees(repo)

    expect(worktrees.map((worktree) => worktree.path)).toEqual([repo])
    expect(worktrees.some((worktree) => worktree.path === deleted)).toBe(false)
  })
})
