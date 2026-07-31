<script lang="ts">
  // Per-hunk accept/reject (and optionally comment) controls, floated over the
  // lines they belong to inside the NvimPane.
  //
  // One component for every kind of review grove has — an agent's proposed
  // write, an inline edit, a file's uncommitted changes — because they are all
  // the same act: judging hunks in the buffer they live in. The callers differ
  // only in where the hunks come from and what a verdict means.
  //
  // Row positions are recomputed from the viewport top on each redraw tick, so
  // the controls track the lines as the buffer scrolls.
  import { nvimSessionFor } from '../lib/nvim/registry'

  // One control: the hunk it decides and the 1-based buffer line it sits on.
  interface HunkAnchor {
    hunkIndex: number
    line: number
  }

  let {
    leafId,
    tick,
    anchors,
    onDecide,
    commentOf,
    onComment
  }: {
    leafId: string
    tick: number
    anchors: HunkAnchor[]
    onDecide: (hunkIndex: number, accept: boolean) => void
    // Commenting is offered only when the caller can carry a comment back to an
    // agent; a working-tree review has nobody to tell.
    commentOf?: (hunkIndex: number) => string
    onComment?: (hunkIndex: number, comment: string) => void
  } = $props()

  let viewportTop = $state(1)
  let cellHeight = $state(18)
  // Hunk whose comment box is open, or null.
  let commenting = $state<number | null>(null)
  let commentDraft = $state('')

  $effect(() => {
    void tick
    void anchors
    const session = nvimSessionFor(leafId)
    if (!session) return
    if (session.cellHeight > 0) cellHeight = session.cellHeight
    void session.viewportTop().then((top) => {
      if (typeof top === 'number') viewportTop = top
    })
  })

  // Close an open comment box when the hunks underneath it change.
  $effect(() => {
    void anchors
    commenting = null
    commentDraft = ''
  })

  function rowY(line: number): number {
    return Math.max(0, line - viewportTop) * cellHeight
  }

  function openComment(hunkIndex: number): void {
    commenting = hunkIndex
    commentDraft = commentOf ? commentOf(hunkIndex) : ''
  }

  function cancelComment(): void {
    commenting = null
    commentDraft = ''
  }

  function saveComment(): void {
    if (commenting === null || !onComment) return
    onComment(commenting, commentDraft)
    commenting = null
    commentDraft = ''
  }
</script>

{#each anchors as anchor (anchor.hunkIndex)}
  <div class="absolute right-2 z-30 flex items-start gap-1" style="top: {rowY(anchor.line)}px">
    {#if commenting === anchor.hunkIndex}
      <div class="w-72 rounded-md border border-line bg-elevated/95 p-1.5 shadow-lg backdrop-blur">
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
      {#if commentOf && commentOf(anchor.hunkIndex)}
        <span
          class="rounded border border-line bg-elevated/95 px-1 py-0.5 text-2xs text-blue shadow"
          title={commentOf(anchor.hunkIndex)}
        >
          ✎
        </span>
      {/if}
      <button
        class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-green shadow hover:bg-hover"
        title="Keep this change"
        onclick={() => onDecide(anchor.hunkIndex, true)}
      >
        ✓
      </button>
      <button
        class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-red shadow hover:bg-hover"
        title="Revert this change"
        onclick={() => onDecide(anchor.hunkIndex, false)}
      >
        ✗
      </button>
      {#if onComment}
        <button
          class="rounded border border-line bg-elevated/95 px-1.5 py-0.5 text-2xs text-muted shadow hover:bg-hover"
          title="Comment on this change for the agent"
          onclick={() => openComment(anchor.hunkIndex)}
        >
          ✎
        </button>
      {/if}
    {/if}
  </div>
{/each}
