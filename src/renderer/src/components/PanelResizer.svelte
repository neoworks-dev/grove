<script lang="ts">
  // Resize handle that lives in the gap between two floating panels rather than
  // on either panel's border. Drives a dock's width; when the dock is collapsed
  // it degrades to a plain spacer so the gutter spacing stays consistent.
  import { layout } from '../lib/layout.svelte'
  import type { DockSide } from '../../../shared/types'

  let { side, enabled = true }: { side: DockSide; enabled?: boolean } = $props()

  let dragging = $state(false)

  function startResize(event: PointerEvent): void {
    if (!enabled) return
    event.preventDefault()
    dragging = true
    const startX = event.clientX
    const startSize = layout.docks[side].size

    const onMove = (move: PointerEvent): void => {
      const delta = move.clientX - startX
      const next = side === 'left' ? startSize + delta : startSize - delta
      layout.resizeDock(side, next)
    }
    const onUp = (): void => {
      dragging = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
</script>

<!-- Gutter element matching the body gap. The visible grab pill is centered in
     it so the highlight sits between panels, never on a border. A negative inset
     widens the pointer hit area past the 4px gap without shifting layout. -->
<div
  class="group relative flex w-2 shrink-0 items-stretch justify-center {enabled
    ? 'cursor-col-resize'
    : ''}"
  role="separator"
  aria-orientation="vertical"
  onpointerdown={startResize}
>
  {#if enabled}
    <div class="absolute inset-y-0 -left-1 -right-1 z-raised"></div>
    <div
      class="my-1.5 w-0.5 rounded-full transition-colors {dragging
        ? 'bg-accent'
        : 'bg-transparent group-hover:bg-line-strong'}"
    ></div>
  {/if}
</div>
