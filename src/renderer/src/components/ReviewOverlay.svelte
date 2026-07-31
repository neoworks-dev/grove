<script lang="ts">
  // Per-hunk controls for an agent-write review, floated over the read-only diff
  // nvim is rendering inside the NvimPane. nvim shows the whole file so
  // decisions are made in context; every verdict is taken here.
  //
  // Accept/reject/comment buttons sit at each hunk's first changed row, and the
  // row positions are recomputed on each redraw tick. The batch-wide actions
  // live in ReviewHeaderBar, above the canvas.
  import { review } from '../lib/review.svelte'
  import { nvimSessionFor } from '../lib/nvim/registry'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const batch = $derived(review.active)
  const file = $derived(review.activeFile)
  // Only the pane actually hosting the diff draws the controls.
  // Match on the nvim process, not the leaf id: the layout can rename a leaf
  // while a review is open, and a leaf-keyed check would silently stop matching
  // the pane the diff is actually in.
  const visible = $derived(
    batch !== null &&
      file !== null &&
      review.ownerNvimId !== null &&
      nvimSessionFor(leafId)?.id === review.ownerNvimId
  )

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

  // Close an open comment box when the file being reviewed changes underneath it.
  $effect(() => {
    void review.activeFileIndex
    commenting = null
    commentDraft = ''
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

  function cancelComment(): void {
    commenting = null
    commentDraft = ''
  }

  function saveComment(): void {
    if (!file || commenting === null) return
    review.comment(file.relPath, commenting, commentDraft)
    commenting = null
    commentDraft = ''
  }

  // Clicking the verdict a hunk already carries clears it back to undecided, so
  // a misclick is undone the same way it was made.
  function decide(index: number, status: 'accepted' | 'rejected'): void {
    if (!file) return
    const next = review.statusOf(file.relPath, index) === status ? 'pending' : status
    review.decide(file.relPath, index, next)
  }
</script>

{#if visible && batch && file}
  <!-- Per-hunk verdicts, anchored to the hunk's first changed row. -->
  {#each file.hunks as _hunk, index (index)}
    {@const offset = rowOffsets[index]}
    {#if offset !== null && offset !== undefined}
      {@const status = statusFor(index)}
      {@const comment = review.commentOf(file.relPath, index)}
      <div class="absolute right-2 z-30 flex items-start gap-1" style="top: {offset}px">
        {#if commenting === index}
          <div
            class="w-72 rounded-md border border-line bg-elevated/95 p-1.5 shadow-lg backdrop-blur"
          >
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="w-full resize-y rounded border border-line bg-input px-1.5 py-1 text-2xs text-default outline-none"
              rows="3"
              placeholder="What should the agent do differently?"
              bind:value={commentDraft}
              autofocus
              onkeydown={(event) => {
                if (event.key === 'Escape') cancelComment()
                else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveComment()
                event.stopPropagation()
              }}
            ></textarea>
            <div class="mt-1 flex items-center gap-1">
              <span class="flex-1 text-2xs text-dim">Esc discards · Ctrl+Enter saves</span>
              <button
                class="rounded px-1.5 py-0.5 text-2xs text-muted hover:bg-hover"
                onclick={cancelComment}
              >
                Cancel
              </button>
              <button
                class="rounded border border-line px-1.5 py-0.5 text-2xs text-default hover:bg-hover"
                onclick={saveComment}
              >
                Save
              </button>
            </div>
          </div>
        {:else}
          {#if comment}
            <span
              class="rounded border border-line bg-elevated/95 px-1 py-0.5 text-2xs text-blue shadow"
              title={comment}
            >
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
