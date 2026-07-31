<script lang="ts">
  // Accept/reject for an inline edit or a file's uncommitted changes, drawn over
  // the buffer they are in. The per-hunk controls are HunkVerdictOverlay, shared
  // with the agent-write review; the summary bar here carries accept-all /
  // reject-all for this file.
  //
  // No comment affordance: an inline review is applied straight to the file and
  // has nobody to report a comment to.
  import { inlineEdit } from '../lib/inlineEdit.svelte'
  import HunkVerdictOverlay from './HunkVerdictOverlay.svelte'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const review = $derived(
    inlineEdit.review && inlineEdit.review.leafId === leafId ? inlineEdit.review : null
  )
  const anchors = $derived(
    !review
      ? []
      : review.ranges
          .filter((range) => review.status[range.hunkIndex] === 'pending')
          .map((range) => ({ hunkIndex: range.hunkIndex, line: range.start }))
  )
</script>

{#if review}
  <div
    class="absolute right-2 top-2 z-30 flex items-center gap-1 rounded-md border border-line bg-elevated/95 px-1.5 py-1 text-2xs shadow-lg backdrop-blur"
  >
    <span class="px-1 text-dim">
      {anchors.length} change{anchors.length === 1 ? '' : 's'}
    </span>
    <button
      class="rounded px-1.5 py-0.5 text-green hover:bg-hover"
      title="Accept all"
      onclick={() => void inlineEdit.resolveAll(true)}
    >
      ✓ All
    </button>
    <button
      class="rounded px-1.5 py-0.5 text-red hover:bg-hover"
      title="Reject all"
      onclick={() => void inlineEdit.resolveAll(false)}
    >
      ✗ All
    </button>
  </div>

  <HunkVerdictOverlay
    {leafId}
    {tick}
    {anchors}
    onDecide={(hunkIndex, accept) => void inlineEdit.decide(hunkIndex, accept)}
  />
{/if}
