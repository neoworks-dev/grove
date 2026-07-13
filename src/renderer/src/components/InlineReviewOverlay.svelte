<script lang="ts">
  // Accept/reject controls for an inline edit under review, floated over the
  // changed lines inside the NvimPane. Per-hunk ✓/✗ sit at each hunk's first
  // changed row; a summary bar offers accept-all / reject-all. Row positions are
  // recomputed from the viewport top on each redraw tick.
  import { inlineEdit } from '../lib/inlineEdit.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const review = $derived(
    inlineEdit.review && inlineEdit.review.leafId === leafId ? inlineEdit.review : null
  )
  const pendingRanges = $derived(
    review ? review.ranges.filter((range) => review.status[range.hunkIndex] === 'pending') : []
  )

  let viewportTop = $state(1)
  let cellHeight = $state(18)

  // Re-read the viewport whenever the buffer redraws (scroll/edit) or the review
  // ranges change, so the floated controls track the lines.
  $effect(() => {
    void tick
    void review?.ranges
    const session = nvimSessionFor(leafId)
    if (!session || !review) return
    if (session.cellHeight > 0) cellHeight = session.cellHeight
    void session.viewportTop().then((top) => {
      if (typeof top === 'number') viewportTop = top
    })
  })

  function rowY(startLine: number): number {
    return Math.max(0, startLine - viewportTop) * cellHeight
  }
</script>

{#if review}
  <div
    class="absolute right-2 top-2 z-30 flex items-center gap-1 rounded-md border border-line bg-elevated/95 px-1.5 py-1 text-2xs shadow-lg backdrop-blur"
  >
    <span class="px-1 text-dim">
      {pendingRanges.length} change{pendingRanges.length === 1 ? '' : 's'}
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

  {#each pendingRanges as range (range.hunkIndex)}
    <div class="absolute right-2 z-30 flex gap-1" style="top: {rowY(range.start)}px">
      <button
        class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-green shadow hover:bg-hover"
        title="Accept this change"
        onclick={() => void inlineEdit.decide(range.hunkIndex, true)}
      >
        ✓
      </button>
      <button
        class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-red shadow hover:bg-hover"
        title="Reject this change"
        onclick={() => void inlineEdit.decide(range.hunkIndex, false)}
      >
        ✗
      </button>
    </div>
  {/each}
{/if}
