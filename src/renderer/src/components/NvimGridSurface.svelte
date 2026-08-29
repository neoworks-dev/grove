<script lang="ts">
  // One canvas projection of an ext_multigrid grid. It borrows the owning
  // session's process, highlights, keyboard sink and RPC channel; mounting a
  // surface never starts another Neovim.
  import { onMount, onDestroy } from 'svelte'
  import type { NvimCanvasSession } from '../lib/nvim/session'

  let {
    session,
    grid,
    win,
    focusOwner = true,
    resizeWindow = false,
    onFocus,
    class: className = ''
  }: {
    session: NvimCanvasSession
    grid: number
    win: number
    focusOwner?: boolean
    resizeWindow?: boolean
    onFocus?: () => void
    class?: string
  } = $props()

  let host = $state<HTMLDivElement>()
  let canvas = $state<HTMLCanvasElement>()
  let dragButton = $state<string | null>(null)
  let lastDragRow = -1
  let lastDragCol = -1

  function modifier(event: MouseEvent | WheelEvent): string {
    return `${event.ctrlKey ? 'C' : ''}${event.shiftKey ? 'S' : ''}${event.altKey ? 'A' : ''}`
  }

  function cell(event: MouseEvent | WheelEvent): { row: number; col: number } | null {
    if (!host) return null
    const rect = host.getBoundingClientRect()
    const col = Math.floor((event.clientX - rect.left) / Math.max(1, session.cellWidth))
    const row = Math.floor((event.clientY - rect.top) / Math.max(1, session.cellHeight))
    return { row: Math.max(0, row), col: Math.max(0, col) }
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.altKey) return
    const point = cell(event)
    const button = ['left', 'middle', 'right'][event.button]
    if (!point || !button) return
    event.preventDefault()
    event.stopPropagation()
    if (focusOwner) {
      session.focus()
    }
    onFocus?.()
    dragButton = button
    lastDragRow = point.row
    lastDragCol = point.col
    session.inputMouseOnGrid(grid, button, 'press', modifier(event), point.row, point.col)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(event: MouseEvent): void {
    if (!dragButton) return
    const point = cell(event)
    if (!point) return
    if (point.row === lastDragRow && point.col === lastDragCol) return
    lastDragRow = point.row
    lastDragCol = point.col
    session.inputMouseOnGrid(grid, dragButton, 'drag', modifier(event), point.row, point.col)
  }

  function onMouseUp(event: MouseEvent): void {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    const button = dragButton
    dragButton = null
    if (!button) return
    const point = cell(event)
    if (!point) return
    session.inputMouseOnGrid(grid, button, 'release', modifier(event), point.row, point.col)
  }

  function onWheel(event: WheelEvent): void {
    const point = cell(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    if (event.deltaY !== 0) {
      session.inputMouseOnGrid(
        grid,
        'wheel',
        event.deltaY > 0 ? 'down' : 'up',
        modifier(event),
        point.row,
        point.col
      )
    }
  }

  onMount(() => {
    if (!host || !canvas) return
    return session.attachGridSurface(grid, host, canvas, resizeWindow ? win : undefined)
  })

  onDestroy(() => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  })
</script>

<div
  bind:this={host}
  class="h-full w-full overflow-hidden {className}"
  onmousedown={onMouseDown}
  onwheel={onWheel}
>
  <canvas bind:this={canvas} class="block h-full w-full"></canvas>
</div>
