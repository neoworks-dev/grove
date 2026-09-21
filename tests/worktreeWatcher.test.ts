// The watcher's ignore list decides what a worktree watch follows. Judging it
// against the whole path used to ignore the watched root itself, because a
// grove worktree lives under `.worktrees/`.

import { describe, expect, it } from 'bun:test'
import { isIgnoredPath } from '../src/main/watcher'

const WORKTREE = '/home/dev/.worktrees/feature-x'

describe('isIgnoredPath', () => {
  it('does not ignore a worktree that lives under .worktrees', () => {
    expect(isIgnoredPath(WORKTREE, WORKTREE)).toBe(false)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/src/index.ts`)).toBe(false)
  })

  it('ignores the directories we never follow below the root', () => {
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/.git/HEAD`)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/node_modules/pkg/index.js`)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/out/main.js`)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/dist/bundle.js`)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/.workbench/state.json`)).toBe(true)
  })

  it('still ignores a worktree nested inside the one being watched', () => {
    const repo = '/home/dev/repo'
    expect(isIgnoredPath(repo, `${repo}/.worktrees/other/src/index.ts`)).toBe(true)
  })
})
