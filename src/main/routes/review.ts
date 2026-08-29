// Agent review: deciding a diff, which writes files and answers the agent.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import type { HunkDecision } from '../../shared/types'

export const reviewRoutes = {
  name: 'main/routes/review',
  inject: ['workbench', 'review', 'agentReview'],

  apply(ctx: Context): void {
    route(ctx, 'agents:discardReview', (_e, batchId: string) => {
      ctx.agentReview.discard(batchId)
      ctx.review.drop(batchId)
    })

    route(ctx, 'agents:resolveReview', async (_e, batchId: string, decisions: HunkDecision[]) => {
      const batch = await ctx.review.resolve(batchId, decisions)
      // Reporting releases the agent: a gated write is answered as the tool call
      // it is, anything else as a message.
      if (batch) await ctx.agentReview.report(batch, decisions)
    })
  }
}
