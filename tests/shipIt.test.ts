import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import * as git from '../src/main/git'
import { prCreateArgs, prMergeArgs, quote } from '../src/main/github'

// Create a temp repo with an initial commit on `main`, isolated from the user's
// git config/hooks.
async function setupRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shipit-repo-'))
  const g = simpleGit({ baseDir: dir })
  await g.init()
  await g.addConfig('user.email', 'test@example.com')
  await g.addConfig('user.name', 'Test')
  await g.addConfig('commit.gpgsign', 'false')
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await g.add('.')
  await g.commit('initial')
  await g.raw(['branch', '-M', 'main'])
  return dir
}

// Add a worktree on a fresh branch off main; returns its path.
async function addFeatureWorktree(repo: string, branch: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'shipit-wt-'))
  const worktreePath = join(parent, branch)
  await git.addWorktree(repo, worktreePath, { newBranch: branch, baseBranch: 'main' })
  return worktreePath
}

describe('stage / unstage / commit', () => {
  it('stages a file, unstages it, then commits', async () => {
    const repo = await setupRepo()
    const wt = await addFeatureWorktree(repo, 'feature-a')
    await writeFile(join(wt, 'new.txt'), 'content\n')

    await git.stage(wt, ['new.txt'])
    let files = await git.changedFiles(wt)
    expect(files.some((file) => file.path === 'new.txt' && file.staged)).toBe(true)

    await git.unstage(wt, ['new.txt'])
    files = await git.changedFiles(wt)
    expect(files.some((file) => file.path === 'new.txt' && file.staged)).toBe(false)
    // Still present as untracked (working-tree change preserved).
    expect(files.some((file) => file.path === 'new.txt')).toBe(true)

    await git.stage(wt, ['new.txt'])
    const summary = await git.commit(wt, 'add new file')
    expect(summary).toContain('feature-a')

    files = await git.changedFiles(wt)
    expect(files).toHaveLength(0)
    expect(await git.currentBranch(wt)).toBe('feature-a')
  })

  it('stage is a no-op for an empty path list', async () => {
    const repo = await setupRepo()
    const wt = await addFeatureWorktree(repo, 'feature-empty')
    await expect(git.stage(wt, [])).resolves.toBeUndefined()
  })
})

describe('mergeToBase', () => {
  it('merges a feature branch into the base in the main worktree', async () => {
    const repo = await setupRepo()
    const wt = await addFeatureWorktree(repo, 'feature-b')
    await writeFile(join(wt, 'feature.txt'), 'from feature\n')
    await git.stage(wt, ['feature.txt'])
    await git.commit(wt, 'add feature file')

    await git.mergeToBase(repo, 'feature-b', 'main')

    // The base worktree now contains the feature commit's file.
    const content = await git.fileAtRef(repo, 'HEAD', 'feature.txt')
    expect(content).toContain('from feature')
  })

  it('refuses to merge when the main worktree is dirty', async () => {
    const repo = await setupRepo()
    const wt = await addFeatureWorktree(repo, 'feature-c')
    await writeFile(join(wt, 'x.txt'), 'x\n')
    await git.stage(wt, ['x.txt'])
    await git.commit(wt, 'x')
    // Dirty the main worktree.
    await writeFile(join(repo, 'README.md'), 'changed\n')

    await expect(git.mergeToBase(repo, 'feature-c', 'main')).rejects.toThrow(/uncommitted/)
  })
})

describe('deleteBranch', () => {
  it('deletes a merged branch', async () => {
    const repo = await setupRepo()
    const wt = await addFeatureWorktree(repo, 'feature-d')
    await writeFile(join(wt, 'f.txt'), 'f\n')
    await git.stage(wt, ['f.txt'])
    await git.commit(wt, 'f')
    await git.mergeToBase(repo, 'feature-d', 'main')
    // Remove the worktree first so the branch is no longer checked out.
    await git.removeWorktree(repo, wt, true)

    await git.deleteBranch(repo, 'feature-d', false)
    const branches = await git.listBranches(repo)
    expect(branches.all).not.toContain('feature-d')
  })
})

describe('gh argument builders', () => {
  it('builds pr create args with quoted values', () => {
    expect(prCreateArgs({ title: 'My PR', body: 'Body text', base: 'main' })).toEqual([
      'pr',
      'create',
      '--base',
      "'main'",
      '--title',
      "'My PR'",
      '--body',
      "'Body text'"
    ])
  })

  it('builds pr merge args, honoring method and delete-branch', () => {
    expect(prMergeArgs({ method: 'squash', deleteBranch: true })).toEqual([
      'pr',
      'merge',
      '--squash',
      '--delete-branch'
    ])
    expect(prMergeArgs({ method: 'merge', deleteBranch: false })).toEqual(['pr', 'merge', '--merge'])
  })

  it('escapes single quotes for the shell', () => {
    expect(quote("it's")).toBe("'it'\\''s'")
  })
})
