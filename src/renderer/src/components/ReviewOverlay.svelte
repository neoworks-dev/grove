<script lang="ts">
  // Controls for an agent-write review, floated over the read-only diff nvim is
  // rendering inside the NvimPane. nvim shows the whole file so decisions are
  // made in context; every verdict is taken here.
  //
  // Per-hunk accept/reject/comment buttons sit at each hunk's first changed row.
  // A header bar carries the file navigation, the batch-wide actions, and the
  // finish button. Row positions are recomputed on each redraw tick.
  import { review } from '../lib/review.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const batch = $derived(review.active)
  const file = $derived(review.activeFile)
  // Only the pane actually hosting the diff draws the controls.
  const visible = $derived(batch !== null && file !== null && review.leafOwner === leafId)

  // Pixel offset of each hunk's first changed row, or null when scrolled away.
  let rowOffsets = $state<(number | null)[]>([])
  // Hunk index whose comment box is open, or null.
  let commenting = $state<number | null>(null)
  let commentDraft = $state('')

  // The result-side line each hunk starts on. A pure insertion has no removed
  // lines, so its marker belongs on the first added row.
  const hunkLines = $derived(file ? file.hunks.map((hunk) => Math.max(1, hunk.afterStart)) : [])

  $effect(() => {
    void tick
    void hunkLines
    if (!visible) {
      rowOffsets = []
      return
    }
    const session = nvimSessionFor(leafId)
    if (!session) return
    void session.reviewRowOffsets(hunkLines).then((offsets) => {
      rowOffsets = offsets
    })
  })

  function statusFor(index: number): string {
    if (!file) return 'pending'
    return review.statusOf(file.relPath, index)
  }

  function openComment(index: number): void {
    if (!file) return
    commenting = index
    commentDraft = review.commentOf(file.relPath, index)
  }

  function saveComment(): void {
    if (!file || commenting === null) return
    review.comment(file.relPath, commenting, commentDraft)
    commenting = null
    commentDraft = ''
  }

  function decide(index: number, status: 'accepted' | 'rejected'): void {
    if (!file) return
    review.decide(file.relPath, index, status)
  }
</script>

{#if visible && batch && file}
  <!-- Header: which file of the batch, navigation, batch-wide verdicts. -->
  <div
    class="absolute left-2 right-2 top-2 z-30 flex items-center gap-2 rounded-md border border-line bg-elevated/95 px-2 py-1 text-2xs shadow-lg backdrop-blur"
  >
    <span class="truncate font-mono text-default">{file.relPath}</span>
    <span class="shrink-0 text-dim">
      {review.activeFileIndex + 1}/{batch.files.length}
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
      <span class="truncate text-dim" title={batch.summary}>{batch.summary}</span>
    {/if}
    <button
      class="rounded px-1.5 py-0.5 text-green hover:bg-hover"
      title="Accept every remaining change in this review"
      onclick={() => review.decideAll('accepted')}
    >
      ✓ All
    </button>
    <button
      class="rounded px-1.5 py-0.5 text-red hover:bg-hover"
      title="Reject every remaining change in this review"
      onclick={() => review.decideAll('rejected')}
    >
      ✗ All
    </button>
    <button
      class="rounded border border-line px-1.5 py-0.5 text-default hover:bg-hover"
      title="Apply these decisions and tell the agent"
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

  <!-- Per-hunk verdicts, anchored to the hunk's first changed row. -->
  {#each file.hunks as _hunk, index (index)}
    {@const offset = rowOffsets[index]}
    {#if offset !== null && offset !== undefined}
      {@const status = statusFor(index)}
      <div class="absolute right-2 z-30 flex items-start gap-1" style="top: {offset + 28}px">
        {#if commenting === index}
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="w-64 rounded border border-line bg-input px-1.5 py-1 text-2xs text-default outline-none"
            rows="3"
            placeholder="What should the agent do differently?"
            bind:value={commentDraft}
            autofocus
            onkeydown={(event) => {
              if (event.key === 'Escape') commenting = null
              else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveComment()
              event.stopPropagation()
            }}
            onblur={saveComment}
          ></textarea>
        {:else}
          {#if review.commentOf(file.relPath, index)}
            <span class="rounded bg-elevated/95 px-1 text-2xs text-blue shadow" title="Commented">
              ✎
            </span>
          {/if}
          <button
            class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs shadow hover:bg-hover {status ===
            'accepted'
              ? 'text-green'
              : 'text-muted'}"
            title="Keep this change"
            onclick={() => decide(index, 'accepted')}
          >
            ✓
          </button>
          <button
            class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs shadow hover:bg-hover {status ===
            'rejected'
              ? 'text-red'
              : 'text-muted'}"
            title="Revert this change"
            onclick={() => decide(index, 'rejected')}
          >
            ✗
          </button>
          <button
            class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-muted shadow hover:bg-hover"
            title="Comment on this change for the agent"
            onclick={() => openComment(index)}
          >
            ✎
          </button>
        {/if}
      </div>
    {/if}
  {/each}
{/if}
