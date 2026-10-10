// Rewinding a session's worktree to how it was when one of its prompts was sent.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { captureTree, diffTrees, promptSnapshot, promptSnapshotsOf } from '../checkpoints'
import type { RewindSnapshot } from '../../shared/agents'

export const rewindRoutes = {
  name: 'main/routes/rewind',
  inject: ['checkpoints', 'agents'],

  apply(ctx: Context): void {
    // Which prompts have a snapshot to go back to.
    route(ctx, 'rewind:snapshots', async (_e, sessionId: string): Promise<RewindSnapshot[]> => {
      const session = await ctx.agents.getSession(sessionId)
      const list = ctx.checkpoints.list(session.workspaceRoot)
      return promptSnapshotsOf(list, sessionId).map((meta) => ({
        promptSeq: meta.promptSeq ?? 0,
        tree: meta.tree
      }))
    })

    // The files a restore would change: what the worktree is now, against what it was.
    route(ctx, 'rewind:changes', async (_e, sessionId: string, promptSeq: number) => {
      const { root, tree } = await snapshotOf(ctx, sessionId, promptSeq)
      const current = await captureTree(root)
      return diffTrees(root, current, tree)
    })

    // The restore takes its own safety snapshot first, so it can be undone.
    route(ctx, 'rewind:restoreCode', async (_e, sessionId: string, promptSeq: number) => {
      const { root, tree } = await snapshotOf(ctx, sessionId, promptSeq)
      return ctx.checkpoints.restoreTree(root, tree)
    })
  }
}

/** The worktree and the tree recorded for one prompt; throws when the prompt has no snapshot. */
async function snapshotOf(
  ctx: Context,
  sessionId: string,
  promptSeq: number
): Promise<{ root: string; tree: string }> {
  const session = await ctx.agents.getSession(sessionId)
  const meta = promptSnapshot(ctx.checkpoints.list(session.workspaceRoot), sessionId, promptSeq)
  if (!meta) throw new Error('No snapshot was taken when this prompt was sent.')
  return { root: session.workspaceRoot, tree: meta.tree }
}
