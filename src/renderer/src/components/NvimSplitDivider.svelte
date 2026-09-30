<script lang="ts">
  // The divider between two of an editor pane's nvim splits, drawn over the
  // separator cell nvim leaves between them. It behaves like the gutter between
  // Grove panes: a line always, a brighter handle on hover, drag to resize, and
  // a `+` that opens a new nvim split beside it. Sizes stay nvim's — a drag sets
  // the window before the divider to whole cells, as dragging nvim's own
  // separator does.
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon'
  import type { NvimCanvasSession } from '../lib/nvim/session'
  import { draggedCells, type SplitDivider } from '../lib/nvim/splitDividers'

  let { session, divider }: { session: NvimCanvasSession; divider: SplitDivider } = $props()

  const vertical = $derived(divider.orientation === 'vertical')

  let dragging = $state(false)
  let startPosition = 0
  let startCells = 0
  let pixelDelta = 0
  let requestedCells = 0
  let frame: number | null = null

  // Splits the window before the divider and moves the cursor into the new
  // window, which nvim opens on the divider's side of it.
  const SPLIT_LUA = `
local win, vertical = ...
local created = vim.api.nvim_win_call(win, function()
  vim.cmd(vertical and 'rightbelow vsplit' or 'rightbelow split')
  return vim.api.nvim_get_current_win()
end)
vim.api.nvim_set_current_win(created)
`

  /** The divider's box: the separator cell along the after-window's edge. */
  function boxStyle(): string {
    const after = divider.after
    if (vertical) {
      const left = session.screenColToPixel(after.col - 1)
      const right = session.screenColToPixel(after.col)
      const top = session.screenRowToPixel(after.row)
      const bottom = session.screenRowToPixel(after.row + after.height)
      return `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`
    }
    const top = session.screenRowToPixel(after.row - 1)
    const bottom = session.screenRowToPixel(after.row)
    const left = session.screenColToPixel(after.col)
    const right = session.screenColToPixel(after.col + after.width)
    return `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px`
  }

  /** Centres the line across the hit zone. */
  function lineStyle(): string {
    if (vertical) return 'left:50%;transform:translateX(-50%)'
    return 'top:50%;transform:translateY(-50%)'
  }

  /** Pixels one cell spans along the drag. */
  function cellPixels(): number {
    if (vertical) return session.cellWidth
    return session.cellHeight
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true
    startPosition = vertical ? event.clientX : event.clientY
    startCells = vertical ? divider.before.width : divider.before.height
    requestedCells = startCells
    pixelDelta = 0
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Not an active pointer (synthetic): the window listeners still see it.
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const position = vertical ? event.clientX : event.clientY
    pixelDelta = position - startPosition
    if (frame === null) frame = requestAnimationFrame(applyDrag)
  }

  /** Sends the dragged size to nvim, once per frame and only when it changed. */
  function applyDrag(): void {
    frame = null
    const cells = draggedCells(startCells, pixelDelta, cellPixels())
    if (cells === requestedCells) return
    requestedCells = cells
    resizeTo(cells)
  }

  /** Sets the before-window's width or height, in cells. */
  function resizeTo(cells: number): void {
    const id = session.id
    if (!id) return
    const method = vertical ? 'nvim_win_set_width' : 'nvim_win_set_height'
    void window.workbench.nvim.request(id, method, [divider.before.win, cells]).catch(() => {})
  }

  function endDrag(): void {
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    applyDrag()
    dragging = false
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
  }

  // Keyboard resize, a cell at a time, for the focused handle.
  function onKeyDown(event: KeyboardEvent): void {
    const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const shrink = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!grow && !shrink) return
    event.preventDefault()
    const current = vertical ? divider.before.width : divider.before.height
    resizeTo(Math.max(1, current + (grow ? 1 : -1)))
  }

  /** Opens a new nvim split at this divider. */
  function split(): void {
    const id = session.id
    if (!id) return
    void window.workbench.nvim
      .request(id, 'nvim_exec_lua', [SPLIT_LUA, [divider.before.win, vertical]])
      .catch(() => {})
  }
</script>

<div
  class="group/divider pointer-events-auto absolute z-raised"
  style={boxStyle()}
  role="separator"
  aria-orientation={vertical ? 'vertical' : 'horizontal'}
>
  <!-- Hit zone a little wider than the separator cell, so it is easy to grab;
       the line is centred in it. -->
  <div
    class="absolute"
    class:cursor-col-resize={vertical}
    class:cursor-row-resize={!vertical}
    class:-left-0.5={vertical}
    class:-right-0.5={vertical}
    class:inset-y-0={vertical}
    class:-top-0.5={!vertical}
    class:-bottom-0.5={!vertical}
    class:inset-x-0={!vertical}
    role="separator"
    aria-orientation={vertical ? 'vertical' : 'horizontal'}
    tabindex="0"
    onpointerdown={onPointerDown}
    onkeydown={onKeyDown}
  >
    {#if dragging}
      <div
        class="absolute bg-accent"
        class:inset-y-0={vertical}
        class:w-0.5={vertical}
        class:inset-x-0={!vertical}
        class:h-0.5={!vertical}
        style={lineStyle()}
      ></div>
    {:else}
      <div
        class="absolute bg-line transition-colors group-hover/divider:bg-line-strong"
        class:inset-y-0={vertical}
        class:w-px={vertical}
        class:inset-x-0={!vertical}
        class:h-px={!vertical}
        style={lineStyle()}
      ></div>
    {/if}
  </div>

  <!-- Split here. Sits above the drag zone and swallows its own pointerdown, so
       pressing it never starts a resize. -->
  {#if !dragging}
    <button
      class="absolute left-1/2 top-1/2 z-overlay flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-elevated text-dim opacity-0 transition-opacity duration-100 hover:text-default group-hover/divider:opacity-100"
      title="Split here"
      aria-label="Split here"
      onpointerdown={(event) => event.stopPropagation()}
      onclick={split}
    >
      <PlusIcon size={11} weight="bold" />
    </button>
  {/if}
</div>
