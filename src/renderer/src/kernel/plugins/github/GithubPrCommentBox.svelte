<script lang="ts">
  // The comment box for a pull-request review, drawn over the buffer it is about
  // and opened against the line it refers to — so the line stays in view while
  // the comment is written, which is the whole reason to write it here rather
  // than in a pane beside the editor.
  //
  // It is placed from the screen position Neovim reported when the key was
  // pressed, not from the buffer line. A diff is mostly filler lines, and folds
  // and wrapping move a line as well, so counting buffer lines down from the top
  // of the window lands rows away from the cursor — on the base side of a diff,
  // by as many rows as the pull request deleted above it.
  //
  // Registered as an editor overlay, so it appears in whichever Neovim pane the
  // review keys were pressed in and in none of the others.
  import Kbd from '../../../components/Kbd.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import { nvimSessionFor } from '../../../lib/nvim/registry'
  import { placeCommentBox } from './prCommentPlacement'
  import { cancelPrComment, github, prThreadById, savePrComment } from './store.svelte'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const target = $derived(
    github.prComment && github.prComment.leafId === leafId ? github.prComment : null
  )

  let body = $state('')
  let input = $state<HTMLTextAreaElement | null>(null)
  let anchor = $state<HTMLDivElement | null>(null)
  let boxHeight = $state(0)
  let paneHeight = $state(0)
  let paneWidth = $state(0)

  // A new target is a new comment; the draft never carries over to another line.
  // The box is opened by a key pressed in the editor, so the canvas has focus
  // and `autofocus` alone does not take it — the field is focused explicitly.
  $effect(() => {
    if (!target) return
    body = ''
    input?.focus()
  })

  // The pane the box is drawn in, re-read on each redraw so a resize moves it.
  $effect(() => {
    void tick
    void target
    const host = anchor?.offsetParent
    if (!(host instanceof HTMLElement)) return
    paneHeight = host.clientHeight
    paneWidth = host.clientWidth
  })

  const session = $derived(nvimSessionFor(leafId))
  const rowHeight = $derived(session && session.cellHeight > 0 ? session.cellHeight : 18)

  // Neovim counts screen rows and columns from 1; the canvas measures from 0.
  const rowTop = $derived.by(() => {
    void tick
    if (!target || !session) return 0
    return session.screenRowToPixel(target.screenRow - 1)
  })

  const columnLeft = $derived.by(() => {
    void tick
    if (!target || !session) return 0
    return session.screenColToPixel(target.screenCol - 1)
  })

  // The thread being answered, read back from the store rather than captured,
  // so a reply that lands shows up in the box that wrote it.
  const thread = $derived(
    target && target.threadId ? prThreadById(target.number, target.threadId) : null
  )

  const placement = $derived(
    placeCommentBox({ rowTop, columnLeft, rowHeight, boxHeight, paneWidth, paneHeight })
  )
</script>

{#if target}
  <div
    bind:this={anchor}
    class="pointer-events-none absolute z-40"
    style="top: {placement.top}px; left: {placement.left}px; width: {placement.width}px"
  >
    <div
      bind:clientHeight={boxHeight}
      class="pointer-events-auto rounded-md border border-line bg-elevated/95 p-2 shadow-lg backdrop-blur"
      class:-translate-y-full={!placement.below}
    >
      {#if thread}
        <div class="mb-1.5 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
          {#each thread.comments as comment (comment.id)}
            <div class="border-l-2 border-line pl-2">
              <div class="flex items-center gap-1 text-2xs">
                <span class="text-muted">{comment.author.login}</span>
                {#if comment.pending}
                  <GithubBadge tone="blue" title="Not submitted yet">draft</GithubBadge>
                {/if}
              </div>
              <p class="whitespace-pre-wrap text-2xs text-default">{comment.body}</p>
            </div>
          {/each}
        </div>
      {/if}
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
        rows="3"
        placeholder={thread
          ? 'Reply…'
          : target.line === null
            ? 'What needs to change in this file?'
            : 'What about this line?'}
        bind:value={body}
        autofocus
        onkeydown={(event) => {
          if (event.key === 'Escape') cancelPrComment()
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
            void savePrComment(target, body)
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
          onclick={() => void savePrComment(target, body)}
        >
          {thread ? 'Reply' : 'Comment'}
        </button>
      </div>
    </div>
  </div>
{/if}
