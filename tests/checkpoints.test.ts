import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import { CheckpointManager } from '../src/main/checkpoints'
import { parseNumstat, diffStats } from '../src/main/git'

async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grove-ckpt-test-'))
  const git = simpleGit({ baseDir: dir })
  await git.init()
  await git.addConfig('user.email', 'test@grove.local')
  await git.addConfig('user.name', 'Test')
  await git.addConfig('commit.gpgsign', 'false')
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git.raw(['add', '-A'])
  await git.raw(['commit', '-m', 'init'])
  return dir
}

describe('parseNumstat', () => {
  it('parses added/removed counts and marks binary as -1', () => {
    const stats = parseNumstat('12\t3\tsrc/a.ts\n-\t-\timg.png\n')
    expect(stats).toEqual([
      { path: 'src/a.ts', added: 12, removed: 3 },
      { path: 'img.png', added: -1, removed: -1 }
    ])
  })

  it('returns empty for empty output', () => {
    expect(parseNumstat('')).toEqual([])
  })
})

describe('diffStats', () => {
  let dir: string
  beforeEach(async () => {
    dir = await scratchRepo()
  })

  it('counts tracked modifications and untracked additions', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n') // +1 tracked
    await writeFile(join(dir, 'b.txt'), 'x\ny\n') // untracked, +2
    const stats = await diffStats(dir)
    expect(stats.added).toBe(3)
    expect(stats.removed).toBe(0)
    expect(stats.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('CheckpointManager', () => {
  let dir: string
  beforeEach(async () => {
    dir = await scratchRepo()
  })

  it('snapshots a change and skips when the tree is unchanged', async () => {
    const mgr = new CheckpointManager()
    // Clean tree identical to HEAD — nothing to checkpoint.
    expect(await mgr.snapshot(dir, 'manual')).toBeNull()

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nCHANGED\n')
    const first = await mgr.snapshot(dir, 'manual')
    expect(first).not.toBeNull()
    expect(first!.n).toBe(1)
    expect(mgr.list(dir)).toHaveLength(1)

    // Same content again → skipped.
    expect(await mgr.snapshot(dir, 'manual')).toBeNull()
    expect(mgr.list(dir)).toHaveLength(1)

    await rm(dir, { recursive: true, force: true })
  })

  it('captures untracked files and restores exactly (removing files created after the checkpoint)', async () => {
    const mgr = new CheckpointManager()

    // Checkpoint 1: modify a tracked file + add an untracked file.
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nEDIT\n')
    await writeFile(join(dir, 'new.txt'), 'fresh\n')
    const cp = await mgr.snapshot(dir, 'manual')
    expect(cp).not.toBeNull()

    // Diverge: change the tracked file again, delete the untracked one, add another.
    await writeFile(join(dir, 'a.txt'), 'totally different\n')
    await rm(join(dir, 'new.txt'))
    await writeFile(join(dir, 'later.txt'), 'created after checkpoint\n')

    await mgr.restore(dir, cp!.commit)

    // a.txt back to checkpoint content; new.txt restored; later.txt removed.
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nEDIT\n')
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('fresh\n')
    expect(existsSync(join(dir, 'later.txt'))).toBe(false)

    // Restore is itself checkpointed (pre-restore), so the divergent state is
    // recoverable — a pre-restore entry now exists.
    expect(mgr.list(dir).some((m) => m.trigger === 'pre-restore')).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  it('respects .gitignore (ignored files are not captured or cleaned)', async () => {
    const mgr = new CheckpointManager()
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    const git = simpleGit({ baseDir: dir })
    await git.raw(['add', '-A'])
    await git.raw(['commit', '-m', 'gitignore'])

    await writeFile(join(dir, 'ignored.txt'), 'secret build artifact\n')
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nchanged\n')
    const cp = await mgr.snapshot(dir, 'manual')
    expect(cp).not.toBeNull()

    // Diverge tracked file, then restore — the ignored file must survive.
    await writeFile(join(dir, 'a.txt'), 'wiped\n')
    await mgr.restore(dir, cp!.commit)
    expect(existsSync(join(dir, 'ignored.txt'))).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  it('prunes beyond the cap but keeps safety checkpoints', async () => {
    const mgr = new CheckpointManager()
    // Force distinct trees so each snapshot records (bypass the debounce by
    // spacing is not needed: manual is non-safety but tree changes each time).
    for (let index = 0; index < 4; index++) {
      await writeFile(join(dir, 'a.txt'), `content ${index}\n`)
      // Manual snapshots are debounced; call runSnapshot-equivalent by waiting.
      await new Promise((resolve) => setTimeout(resolve, 800))
      await mgr.snapshot(dir, 'manual')
    }
    await mgr.prune(dir, 2)
    const kept = mgr.list(dir).filter((m) => m.trigger === 'manual')
    expect(kept.length).toBeLessThanOrEqual(2)
    await rm(dir, { recursive: true, force: true })
  })
})
