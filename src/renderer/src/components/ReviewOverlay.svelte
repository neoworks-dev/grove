<script lang="ts">
  // Per-hunk verdicts for an agent-write review, drawn over the buffer the file
  // is open in. The controls themselves are HunkVerdictOverlay, shared with the
  // inline and working-tree reviews; this only says which hunks are still open
  // and what a verdict means for a batch. The batch-wide actions live in
  // ReviewHeaderBar, above the canvas.
  import { review } from '../lib/review.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'
  import HunkVerdictOverlay from './HunkVerdictOverlay.svelte'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const file = $derived(review.activeFile)
  // Only the pane actually showing the review draws the controls. Match on the
  // nvim process, not the leaf id: the layout can rename a leaf while a review
  // is open, and a leaf-keyed check would silently stop matching the pane the
  // review is actually in.
  const visible = $derived(
    file !== null &&
      review.ownerNvimId !== null &&
      nvimSessionFor(leafId)?.id === review.ownerNvimId
  )

  // A decided hunk keeps its verdict but loses its controls, so what is still
  // offered is what is still open.
  const anchors = $derived(
    !visible || !file
      ? []
      : review.marks
          .filter((mark) => review.statusOf(file.relPath, mark.hunkIndex) === 'pending')
          .map((mark) => ({ hunkIndex: mark.hunkIndex, line: mark.start }))
  )

  function decide(hunkIndex: number, accept: boolean): void {
    if (!file) return
    review.decide(file.relPath, hunkIndex, accept ? 'accepted' : 'rejected')
  }

  function commentOf(hunkIndex: number): string {
    if (!file) return ''
    return review.commentOf(file.relPath, hunkIndex)
  }

  function comment(hunkIndex: number, text: string): void {
    if (!file) return
    review.comment(file.relPath, hunkIndex, text)
  }
</script>

{#if visible}
  <HunkVerdictOverlay {leafId} {tick} {anchors} onDecide={decide} {commentOf} onComment={comment} />
{/if}
