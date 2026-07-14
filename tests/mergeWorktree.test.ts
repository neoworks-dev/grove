import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit, type SimpleGit } from 'simple-git'
import {
  mergePreview,
  mergeWorktree,
  conflictedFiles,
  abortMerge,
  continueMerge
} from '../src/main/git'

// A repo with a main worktree plus a linked worktree on `feature`, so merges run
// worktree-to-worktree the way the app does them.
async function setup(): Promise<{ root: string; wt: string; git: SimpleGit; wtGit: SimpleGit }> {
  const root = await mkdtemp(join(tmpdir(), 'grove-merge-test-'))
  const git = simpleGit({ baseDir: root })
  await git.init(['-b', 'main'])
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Test')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(root, 'shared.txt'), 'base\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'base'])

  const wt = join(root, 'wt-feature')
  await git.raw(['worktree', 'add', '-b', 'feature', wt, 'main'])
  const wtGit = simpleGit({ baseDir: wt })
  return { root, wt, git, wtGit }
}

describe('mergeWorktree', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    ctx = await setup()
  })

  it('previews and merges a non-conflicting feature branch into main', async () => {
    // Advance feature with a new file.
    await writeFile(join(ctx.wt, 'feature.txt'), 'from feature\n')
    await ctx.wtGit.raw(['add', '-A'])
    await ctx.wtGit.raw(['commit', '-m', 'add feature.txt'])

    const preview = await mergePreview(ctx.root, 'feature')
    expect(preview.alreadyMerged).toBe(false)
    expect(preview.canFastForward).toBe(true)
    expect(preview.commits.map((c) => c.subject)).toContain('add feature.txt')

    const result = await mergeWorktree(ctx.root, 'feature', { mode: 'no-ff' })
    expect(result.status).toBe('merged')

    await rm(ctx.root, { recursive: true, force: true })
  })

  it('reports up-to-date when the source is already merged', async () => {
    const result = await mergeWorktree(ctx.root, 'feature', { mode: 'no-ff' })
    expect(result.status).toBe('up-to-date')
    await rm(ctx.root, { recursive: true, force: true })
  })

  it('detects a conflict and can abort it', async () => {
    // Both branches edit the same line differently.
    await writeFile(join(ctx.root, 'shared.txt'), 'main change\n')
    await ctx.git.raw(['add', '-A'])
    await ctx.git.raw(['commit', '-m', 'main edit'])

    await writeFile(join(ctx.wt, 'shared.txt'), 'feature change\n')
    await ctx.wtGit.raw(['add', '-A'])
    await ctx.wtGit.raw(['commit', '-m', 'feature edit'])

    const result = await mergeWorktree(ctx.root, 'feature', { mode: 'no-ff' })
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') {
      expect(result.files).toContain('shared.txt')
    }
    expect(await conflictedFiles(ctx.root)).toContain('shared.txt')

    await abortMerge(ctx.root)
    expect(await conflictedFiles(ctx.root)).toHaveLength(0)

    await rm(ctx.root, { recursive: true, force: true })
  })

  it('continues a merge after conflicts are resolved', async () => {
    await writeFile(join(ctx.root, 'shared.txt'), 'main change\n')
    await ctx.git.raw(['add', '-A'])
    await ctx.git.raw(['commit', '-m', 'main edit'])
    await writeFile(join(ctx.wt, 'shared.txt'), 'feature change\n')
    await ctx.wtGit.raw(['add', '-A'])
    await ctx.wtGit.raw(['commit', '-m', 'feature edit'])

    const result = await mergeWorktree(ctx.root, 'feature', { mode: 'no-ff' })
    expect(result.status).toBe('conflict')

    // Resolve by picking a merged content and staging it.
    await writeFile(join(ctx.root, 'shared.txt'), 'resolved\n')
    await ctx.git.raw(['add', 'shared.txt'])
    const done = await continueMerge(ctx.root)
    expect(done.status).toBe('merged')
    expect(await conflictedFiles(ctx.root)).toHaveLength(0)

    await rm(ctx.root, { recursive: true, force: true })
  })
})
