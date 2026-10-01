// Session replay: a session's turns and the edits each made, compared and
// rolled back to.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { diffTrees } from '../checkpoints'
import type { AgentEditStep } from '../../shared/agents'

export const replayRoutes = {
  name: 'main/routes/replay',
  inject: ['editSteps', 'checkpoints', 'agents'],

  apply(ctx: Context): void {
    route(ctx, 'replay:session', (_e, sessionId: string) => ctx.editSteps.replay(sessionId))

    // Only trees the session's own steps recorded: the renderer names a step's
    // state, not an arbitrary object in the repository.
    route(ctx, 'replay:compare', async (_e, sessionId: string, from: string, to: string) => {
      const root = await stepRoot(ctx, sessionId, [from, to])
      return diffTrees(root, from, to)
    })

    route(ctx, 'replay:restore', async (_e, sessionId: string, tree: string) => {
      const root = await stepRoot(ctx, sessionId, [tree])
      return ctx.checkpoints.restoreTree(root, tree)
    })
  }
}

/**
 * The session's worktree, once every tree asked about is one its steps
 * recorded. Throws otherwise.
 */
async function stepRoot(ctx: Context, sessionId: string, trees: string[]): Promise<string> {
  const session = await ctx.agents.getSession(sessionId)
  const steps = await ctx.editSteps.stepsOf(sessionId)
  const known = knownTrees(steps)
  for (const tree of trees) {
    if (!known.has(tree)) throw new Error('not a state this session recorded')
  }
  return session.workspaceRoot
}

/** Every tree a session's steps start or end on. */
function knownTrees(steps: readonly AgentEditStep[]): Set<string> {
  const trees = new Set<string>()
  for (const step of steps) {
    trees.add(step.before)
    trees.add(step.after)
  }
  return trees
}
