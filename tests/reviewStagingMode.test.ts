import { describe, it, expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ReviewService } from '../src/main/review'
import type { BaselineSource } from '../src/main/reviewStaging'
import type { ReviewBatch } from '../src/shared/types'

// Gated mode reviews a write at the permission prompt, before it reaches disk.
// Staging the same write afterwards would raise a second review for a change the
// user has already decided on — which is what these tests pin down.

const baseline: BaselineSource = {
  open: async () => 'tree',
  read: async () => ''
}

function build(mode: 'pre' | 'post'): {
  review: ReviewService
  raised: ReviewBatch[]
  staged: number[]
} {
  const raised: ReviewBatch[] = []
  const staged: number[] = []
  const review: ReviewService = new ReviewService(
    baseline,
    {
      // Tracking a raised batch is what makes it resolvable, exactly as the app
      // does it in ipc.ts.
      onReview: (batch) => {
        review.track(batch)
        raised.push(batch)
      },
      onStaged: (_worktreeId, count) => staged.push(count),
      onFeedback: () => {}
    },
    { pause: () => false, postApprove: () => mode === 'post' }
  )
  return { review, raised, staged }
}

async function worktreeWith(relPath: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-mode-'))
  await writeFile(join(root, relPath), content)
  return root
}

describe('resolving a gated review', () => {
  it('leaves the file to the tool call when everything was accepted', async () => {
    const root = await worktreeWith('a.ts', 'one\ntwo\n')
    try {
      const { review } = build('pre')
      const batchId = await review.raiseGated(root, 'nib', 'session-1', 'call-1', 'edit', {
        relPath: 'a.ts',
        baseline: 'one\ntwo\n',
        current: 'one\nTWO\n',
        hunks: [{ beforeStart: 2, removed: ['two'], afterStart: 2, added: ['TWO'] }]
      })

      await review.resolve(batchId, [{ relPath: 'a.ts', hunkIndex: 0, accepted: true }])

      // Writing here would land the change before the allowed tool runs, and the
      // tool would then fail to find its own oldText.
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the surviving hunks itself when one was rejected', async () => {
    const root = await worktreeWith('a.ts', 'one\ntwo\n')
    try {
      const { review } = build('pre')
      const batchId = await review.raiseGated(root, 'nib', 'session-1', 'call-1', 'edit', {
        relPath: 'a.ts',
        baseline: 'one\ntwo\n',
        current: 'ONE\nTWO\n',
        hunks: [
          { beforeStart: 1, removed: ['one'], afterStart: 1, added: ['ONE'] },
          { beforeStart: 2, removed: ['two'], afterStart: 2, added: ['TWO'] }
        ]
      })

      await review.resolve(batchId, [
        { relPath: 'a.ts', hunkIndex: 0, accepted: true },
        { relPath: 'a.ts', hunkIndex: 1, accepted: false }
      ])

      // The tool call is denied in this case, so this is the only write.
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('ONE\ntwo\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('staging follows the review mode', () => {
  it('raises nothing for a write already reviewed at the prompt', async () => {
    const root = await worktreeWith('a.ts', 'one\ntwo\n')
    try {
      const { review, raised } = build('pre')

      // A whole gated turn: the batch is never opened, the tool writes once the
      // user allows it, and the turn ends.
      review.openBatch(root, 'nib', 'session-1')
      review.noteWrite(root, 'a.ts')
      await review.closeTurn(root, 'nib', 'session-1')

      expect(raised).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not resume staging after a turn ends in gated mode', async () => {
    const root = await worktreeWith('a.ts', 'one\ntwo\n')
    try {
      const { review, raised } = build('pre')

      // The second turn is the one that used to collect writes: closing a turn
      // reopened staging regardless of the mode.
      await review.closeTurn(root, 'nib', 'session-1')
      review.noteWrite(root, 'a.ts')
      await review.closeTurn(root, 'nib', 'session-1')

      expect(raised).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still stages and raises in post-approve mode', async () => {
    const root = await worktreeWith('a.ts', 'one\ntwo\n')
    try {
      const { review, raised } = build('post')

      review.openBatch(root, 'nib', 'session-1')
      // The staging layer opens asynchronously; the watcher only reports a write
      // once it has happened.
      await Promise.resolve()
      review.noteWrite(root, 'a.ts')
      await review.closeTurn(root, 'nib', 'session-1')

      expect(raised).toHaveLength(1)
      expect(raised[0].origin).toBe('turn-end')
      expect(raised[0].files.map((file) => file.relPath)).toEqual(['a.ts'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
