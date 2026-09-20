<script lang="ts">
  // The comment box for a pull-request review, drawn over the buffer it is about
  // and anchored above the line it refers to — so the line stays in view while
  // the comment is written, which is the whole reason to write it here rather
  // than in a pane beside the editor.
  //
  // Registered as an editor overlay, so it appears in whichever Neovim pane the
  // review keys were pressed in and in none of the others.
  import Kbd from '../../../components/Kbd.svelte'
  import { nvimSessionFor } from '../../../lib/nvim/registry'
  import { cancelPrComment, github, savePrComment } from './store.svelte'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const target = $derived(
    github.prComment && github.prComment.leafId === leafId ? github.prComment : null
  )

  let body = $state('')
  let viewportTop = $state(1)
  let cellHeight = $state(18)

  // Redrawn on each tick, the way the review overlays are: the line the box
  // points at moves as the buffer scrolls.
  $effect(() => {
    void tick
    void target
    const session = nvimSessionFor(leafId)
    if (!session) return
    if (session.cellHeight > 0) cellHeight = session.cellHeight
    void session.viewportTop().then((top) => {
      if (typeof top === 'number') viewportTop = top
    })
  })

  let input = $state<HTMLTextAreaElement | null>(null)

  // A new target is a new comment; the draft never carries over to another line.
  // The box is opened by a key pressed in the editor, so the canvas has focus
  // and `autofocus` alone does not take it — the field is focused explicitly.
  $effect(() => {
    if (!target) return
    body = ''
    input?.focus()
  })

  // A file-level comment has no line to sit above, so it opens at the top.
  const rowTop = $derived(
    target && target.line !== null ? Math.max(0, target.line - viewportTop) * cellHeight : 0
  )

  // Above the line, unless the line is near the top of the pane and there is no
  // room up there for the box.
  const below = $derived(rowTop < 160)

  async function save(): Promise<void> {
    if (!target) return
    await savePrComment(target, body)
  }
</script>

{#if target}
  <div class="pointer-events-none absolute left-2 right-2 z-40" style="top: {rowTop}px">
    <div class="pointer-events-auto w-[30rem] max-w-full" class:-translate-y-full={!below}>
      <div class="rounded-md border border-line bg-elevated/95 p-2 shadow-lg backdrop-blur">
        <div class="mb-1 flex items-center gap-1 text-2xs text-dim">
          {#if target.line === null}
            <span class="text-red">Asking for changes to</span>
            <span class="truncate font-mono text-muted">{target.path}</span>
          {:else}
            <span class="truncate font-mono text-muted">{target.path}</span>
            <span>line {target.line}</span>
            <span class="text-dim">· {target.side === 'LEFT' ? 'base' : 'head'}</span>
          {/if}
        </div>
        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          bind:this={input}
          class="w-full resize-y rounded border border-line bg-input px-2 py-1 text-2xs text-default outline-none"
          rows="4"
          placeholder={target.line === null
            ? 'What needs to change in this file?'
            : 'What about this line?'}
          bind:value={body}
          autofocus
          onkeydown={(event) => {
            if (event.key === 'Escape') cancelPrComment()
            else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save()
            event.stopPropagation()
          }}
        ></textarea>
        <div class="mt-1 flex items-center gap-1">
          <span class="flex-1 text-2xs text-dim">
            <Kbd>Esc</Kbd> discards · <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> adds it
          </span>
          <button
            class="rounded px-1.5 py-0.5 text-2xs text-muted hover:bg-hover"
            onclick={cancelPrComment}
          >
            Cancel
          </button>
          <button
            class="rounded border border-line px-1.5 py-0.5 text-2xs text-default hover:bg-hover disabled:opacity-50"
            disabled={github.prReviewBusy || body.trim().length === 0}
            onclick={() => void save()}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
