<script lang="ts">
  // Header for an agent-write review: what is being reviewed, file navigation,
  // the batch-wide verdicts and the finish button.
  //
  // It sits above the editor canvas in normal flow rather than floating over it.
  // Floating cost the first lines of the diff, which are exactly the lines a
  // one-hunk review is about.
  import { review } from '../lib/review.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'

  let { leafId }: { leafId: string } = $props()

  const batch = $derived(review.active)
  const file = $derived(review.activeFile)
  // Only the pane actually hosting the diff draws the controls. Match on the
  // nvim process, not the leaf id: the layout can rename a leaf while a review
  // is open, and a leaf-keyed check would silently stop matching the pane the
  // diff is actually in.
  const visible = $derived(
    batch !== null &&
      file !== null &&
      review.ownerNvimId !== null &&
      nvimSessionFor(leafId)?.id === review.ownerNvimId
  )

  const undecided = $derived(review.pendingCount)
</script>

{#if visible && batch && file}
  <div class="flex shrink-0 items-center gap-2 border-b border-line bg-elevated px-2 py-1 text-2xs">
    <span class="truncate font-mono text-default">{file.relPath}</span>
    {#if file.deleted}
      <span class="shrink-0 rounded bg-red-soft px-1 text-red">deleted</span>
    {/if}
    <span class="shrink-0 text-dim">
      file {review.activeFileIndex + 1} of {batch.files.length}
    </span>
    {#if batch.files.length > 1}
      <button
        class="rounded px-1.5 py-0.5 text-muted hover:bg-hover disabled:opacity-40"
        title="Previous file"
        disabled={review.activeFileIndex === 0}
        onclick={() => void review.previousFile()}
      >
        ‹
      </button>
      <button
        class="rounded px-1.5 py-0.5 text-muted hover:bg-hover disabled:opacity-40"
        title="Next file"
        disabled={review.activeFileIndex >= batch.files.length - 1}
        onclick={() => void review.nextFile()}
      >
        ›
      </button>
    {/if}

    <div class="flex-1"></div>

    {#if batch.summary}
      <span class="max-w-[35%] truncate text-dim" title={batch.summary}>{batch.summary}</span>
    {/if}
    <span class="shrink-0 text-dim">{undecided} undecided</span>
    <button
      class="rounded px-1.5 py-0.5 text-green hover:bg-hover"
      title="Keep every remaining change and submit the review"
      onclick={() => void review.resolveAll('accepted')}
    >
      ✓ All
    </button>
    <button
      class="rounded px-1.5 py-0.5 text-red hover:bg-hover"
      title="Revert every remaining change and submit the review"
      onclick={() => void review.resolveAll('rejected')}
    >
      ✗ All
    </button>
    <button
      class="rounded border border-line px-2 py-0.5 text-default hover:bg-hover"
      title="Apply these decisions and report back to the agent"
      onclick={() => void review.finish()}
    >
      Finish
    </button>
    <button
      class="rounded px-1.5 py-0.5 text-muted hover:bg-hover"
      title="Close without deciding; the review stays in the chat"
      onclick={() => review.cancel()}
    >
      ✕
    </button>
  </div>
{/if}
