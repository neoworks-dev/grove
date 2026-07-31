import { describe, it, expect } from 'bun:test'
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { ReviewStaging, type BaselineSource } from '../src/main/reviewStaging'

// A baseline source backed by a plain map, standing in for the checkpoint tree.
// Keyed "tree:relPath" so a test can hold several baselines at once.
function fakeBaseline(contents: Record<string, string>, tree = 't1'): BaselineSource {
  return {
    open: async () => tree,
    read: async (_worktreePath, usedTree, relPath) => contents[`${usedTree}:${relPath}`] ?? ''
  }
}

async function makeWorktree(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'review-staging-'))
}

async function write(root: string, relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, relPath)), { recursive: true })
  await writeFile(join(root, relPath), content)
}

describe('ReviewStaging', () => {
  it('diffs a written file against the batch baseline, not against disk', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'one\ntwo\n' }))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'a.ts', 'one\nCHANGED\n')
      staging.noteWrite(root, 'a.ts')

      const batch = await staging.close(root, 'turn-end')
      expect(batch).not.toBeNull()
      expect(batch!.files).toHaveLength(1)
      expect(batch!.files[0].relPath).toBe('a.ts')
      expect(batch!.files[0].baseline).toBe('one\ntwo\n')
      expect(batch!.files[0].current).toBe('one\nCHANGED\n')
      expect(batch!.files[0].hunks.length).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('collapses repeated writes to one file into a single entry', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'start\n' }))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'a.ts', 'middle\n')
      staging.noteWrite(root, 'a.ts')
      await write(root, 'a.ts', 'end\n')
      staging.noteWrite(root, 'a.ts')

      const batch = await staging.close(root, 'agent', 'did a thing')
      expect(batch!.files).toHaveLength(1)
      // The baseline is the batch's, so intermediate states never surface.
      expect(batch!.files[0].baseline).toBe('start\n')
      expect(batch!.files[0].current).toBe('end\n')
      expect(batch!.summary).toBe('did a thing')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops a file the agent rewrote with identical content', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'same\n' }))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'a.ts', 'same\n')
      staging.noteWrite(root, 'a.ts')

      expect(await staging.close(root, 'turn-end')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a file with no baseline as newly created', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({}))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'docs/new.md', 'hello\n')
      staging.noteWrite(root, 'docs/new.md')

      const batch = await staging.close(root, 'turn-end')
      expect(batch!.files[0].baseline).toBe('')
      expect(batch!.files[0].deleted).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('flags a deleted file so accepting removes it rather than emptying it', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:gone.ts': 'content\n' }))
      await staging.open(root, 'claude', 'chat1')
      staging.noteWrite(root, 'gone.ts') // never written to disk == deleted

      const batch = await staging.close(root, 'turn-end')
      expect(batch!.files[0].deleted).toBe(true)
      expect(batch!.files[0].current).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores writes when no batch is open, and after the batch closes', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'one\n' }))
      await write(root, 'a.ts', 'two\n')
      staging.noteWrite(root, 'a.ts')
      expect(staging.isOpen(root)).toBe(false)
      expect(await staging.close(root, 'turn-end')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the first baseline when open is called again mid-batch', async () => {
    const root = await makeWorktree()
    try {
      // A second open must not re-snapshot: the agent's earlier writes would
      // then diff against their own output and vanish from the review.
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'original\n' }))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'a.ts', 'edited\n')
      staging.noteWrite(root, 'a.ts')
      await staging.open(root, 'claude', 'chat1')

      const batch = await staging.close(root, 'turn-end')
      expect(batch!.files[0].baseline).toBe('original\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discards a batch without raising a review', async () => {
    const root = await makeWorktree()
    try {
      const staging = new ReviewStaging(fakeBaseline({ 't1:a.ts': 'one\n' }))
      await staging.open(root, 'claude', 'chat1')
      await write(root, 'a.ts', 'two\n')
      staging.noteWrite(root, 'a.ts')
      expect(staging.stagedCount(root)).toBe(1)

      staging.discard(root)
      expect(staging.isOpen(root)).toBe(false)
      expect(await staging.close(root, 'turn-end')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
