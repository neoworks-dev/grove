// Agent review: the part of the flow that writes files, so it cannot live on the nib server.

import type { Context } from '@neoworks/extension-system'
import { route } from '../kernel/route'
import { NIB_AGENT } from '../nib/reviewBridge'
import type { HunkDecision } from '../../shared/types'

export const reviewRoutes = {
  name: 'main/routes/review',
  inject: ['workbench', 'review', 'nibReview'],

  apply(ctx: Context): void {
    // ── Agent review ──────────────────────────────────────────────
    // Sessions, transcripts and approvals live on the nib server and are driven
    // from the renderer over grove-nib://. What stays here is the review flow,
    // which writes files and therefore cannot.
    route(ctx, 'agents:discardReview', (_e, batchId: string) => {
      ctx.nibReview.discard(batchId)
      ctx.review.drop(batchId)
    })

    route(ctx, 'agents:resolveReview', async (_e, batchId: string, decisions: HunkDecision[]) => {
      const batch = await ctx.review.resolve(batchId, decisions)
      if (!batch) return
      // A nib session is answered over its own protocol, not the adapter's
      // permission resolver.
      if (batch.agent === NIB_AGENT) {
        await ctx.nibReview.report(batch, decisions)
        return
      }
    })
  }
}
