// The watcher's ignore list decides what a worktree watch follows. Judging it
// against the whole path used to ignore the watched root itself, because a
// grove worktree lives under `.worktrees/`.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { simpleGit } from 'simple-git'
import { ignoredDirectories } from '../src/main/git'
import { isIgnoredPath, WorktreeWatcher, type FsChange } from '../src/main/watcher'

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

describe('isIgnoredPath with what git ignores', () => {
  const gitIgnored = new Set(['runs', 'data/raw'])

  it('ignores a git-ignored directory and everything below it', () => {
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/runs`, gitIgnored)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/runs/a/shot.jpg`, gitIgnored)).toBe(true)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/data/raw/x.bin`, gitIgnored)).toBe(true)
  })

  it('follows its siblings and parents', () => {
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/data`, gitIgnored)).toBe(false)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/data/rawer.txt`, gitIgnored)).toBe(false)
    expect(isIgnoredPath(WORKTREE, `${WORKTREE}/src/runs.ts`, gitIgnored)).toBe(false)
  })
})

describe('WorktreeWatcher', () => {
  let repo = ''
  let watcher: WorktreeWatcher | null = null

  afterEach(async () => {
    await watcher?.closeAll()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  /** A repo with no commits yet whose .gitignore covers runs/ and checkpoints/. */
  async function ignoringRepo(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'grove-watcher-'))
    await simpleGit({ baseDir: path }).init()
    await writeFile(join(path, '.gitignore'), 'runs/\ncheckpoints/\n')
    await mkdir(join(path, 'runs', 'first'), { recursive: true })
    await writeFile(join(path, 'runs', 'first', 'shot.jpg'), '')
    return path
  }

  /** Resolves once the watcher has reported a change to `relPath`, or rejects after a while. */
  function changeTo(changes: FsChange[], relPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = (): void => {
        if (changes.some((change) => change.relPath === relPath)) return resolve()
        if (Date.now() - started > 3000) return reject(new Error(`no change to ${relPath}`))
        setTimeout(poll, 20)
      }
      poll()
    })
  }

  it('lists the directories git ignores, not the files in them', async () => {
    repo = await ignoringRepo()
    expect(await ignoredDirectories(repo)).toEqual(['runs'])
  })

  it('reports no writes under a git-ignored directory, even one created later', async () => {
    repo = await ignoringRepo()
    const changes: FsChange[] = []
    watcher = new WorktreeWatcher((change) => changes.push(change))
    watcher.setWatched([repo])
    await Bun.sleep(300)

    await mkdir(join(repo, 'checkpoints'))
    await Bun.sleep(300)
    await writeFile(join(repo, 'checkpoints', 'step-1.safetensors'), 'x')
    await writeFile(join(repo, 'runs', 'first', 'shot-2.jpg'), 'x')
    await writeFile(join(repo, 'train.py'), 'print(1)')
    await changeTo(changes, 'train.py')
    await Bun.sleep(300)

    const paths = changes.map((change) => change.relPath)
    expect(paths.filter((path) => path.startsWith('runs'))).toEqual([])
    expect(paths.filter((path) => path.startsWith(`checkpoints${sep}`))).toEqual([])
  })
})
