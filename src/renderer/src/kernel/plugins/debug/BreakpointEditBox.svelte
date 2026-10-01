<script lang="ts">
  // The breakpoint editor drawn over the editor, under the line it is for —
  // opened by a right-click in the gutter or the "Edit breakpoint" key.
  // Registered as an editor overlay, so it shows only in the pane the request
  // came from, placed from the screen row Neovim reported.
  import { nvimSessionFor } from '../../../lib/nvim/registry'
  import { placeCommentBox } from '../../../lib/nvim/overlayPlacement'
  import BreakpointForm from './BreakpointForm.svelte'
  import { debug } from './store.svelte'
  import type { DebugBreakpointOptions } from '../../../../../shared/debug'

  let { leafId, tick }: { leafId: string; tick: number } = $props()

  const target = $derived(debug.editing && debug.editing.leafId === leafId ? debug.editing : null)
  const existing = $derived(target ? debug.breakpointAt(target.path, target.line) : null)

  let anchor = $state<HTMLDivElement | null>(null)
  let boxHeight = $state(0)
  let paneHeight = $state(0)
  let paneWidth = $state(0)

  // Opening takes the keyboard from the editor; closing has to hand it back,
  // or keys after it go nowhere.
  $effect(() => {
    if (!target) {
      return
    }
    return () => nvimSessionFor(leafId)?.focus()
  })

  // The pane the box is drawn in, re-read on each redraw so a resize moves it.
  $effect(() => {
    void tick
    void target
    const host = anchor?.offsetParent
    if (!(host instanceof HTMLElement)) {
      return
    }
    paneHeight = host.clientHeight
    paneWidth = host.clientWidth
  })

  const session = $derived(nvimSessionFor(leafId))
  const rowHeight = $derived.by(() => {
    if (session && session.cellHeight > 0) {
      return session.cellHeight
    }
    return 18
  })

  // Neovim counts screen rows and columns from 1; the canvas measures from 0.
  const rowTop = $derived.by(() => {
    void tick
    if (!target || !session) {
      return 0
    }
    return session.screenRowToPixel(target.screenRow - 1)
  })

  const columnLeft = $derived.by(() => {
    void tick
    if (!target || !session) {
      return 0
    }
    return session.screenColToPixel(target.screenCol - 1)
  })

  const placement = $derived(
    placeCommentBox({ rowTop, columnLeft, rowHeight, boxHeight, paneWidth, paneHeight })
  )

  /** Saves the options onto the line's breakpoint, adding it when there is none. */
  function save(options: DebugBreakpointOptions): void {
    if (!target) {
      return
    }
    void debug.saveBreakpoint(target.path, target.line, options)
    debug.closeBreakpointEditor()
  }

  /** Removes the line's breakpoint and closes the box. */
  function remove(): void {
    if (existing) {
      void window.workbench.debugger.removeBreakpoint(existing.id)
    }
    debug.closeBreakpointEditor()
  }

  /** The file's name, for the box's heading. */
  function fileName(path: string): string {
    const name = path.split('/').pop()
    if (name) {
      return name
    }
    return path
  }
</script>

{#if target}
  <div
    bind:this={anchor}
    class="pointer-events-none absolute z-40"
    style:top="{placement.top}px"
    style:left="{placement.left}px"
    style:width="{placement.width}px"
  >
    <div
      bind:clientHeight={boxHeight}
      class="pointer-events-auto rounded-md border border-line bg-elevated/95 p-2 shadow-lg backdrop-blur"
      class:-translate-y-full={!placement.below}
      role="dialog"
      aria-label="Edit breakpoint"
    >
      <div class="mb-1.5 flex items-center gap-1 text-2xs text-dim">
        <span class="text-muted">{existing ? 'Breakpoint' : 'New breakpoint'}</span>
        <span class="truncate font-mono">{fileName(target.path)}:{target.line}</span>
      </div>
      {#key `${target.path}:${target.line}`}
        <BreakpointForm
          initial={existing || {}}
          autofocus
          removable={existing !== null}
          onsave={save}
          oncancel={() => debug.closeBreakpointEditor()}
          onremove={remove}
        />
      {/key}
    </div>
  </div>
{/if}
