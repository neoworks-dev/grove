<script lang="ts">
  // Full-viewport, pointer-transparent overlay shown while a pane is being
  // Alt-dragged. Highlights the target leaf and previews the landing spot as a
  // placeholder rectangle (full pane for a center drop, a half for an edge).
  import { paneDrag } from '../lib/paneDrag.svelte'
  import { placeholderRect } from '../lib/paneDragCore'

  const target = $derived(paneDrag.target)
  const placeholder = $derived(target ? placeholderRect(target.rect, target.zone) : null)
  const label = $derived.by(() => {
    if (!target) return ''
    if (target.zone === 'center') return 'Swap'
    return 'Split'
  })
</script>

{#if paneDrag.active}
  <div class="pointer-events-none fixed inset-0 z-overlay">
    {#if target}
      <!-- Target pane outline. -->
      <div
        class="absolute rounded-sm border-2 border-accent/40"
        style="left:{target.rect.left}px; top:{target.rect.top}px; width:{target.rect
          .width}px; height:{target.rect.height}px"
      ></div>
    {/if}
    {#if placeholder}
      <!-- Landing placeholder. -->
      <div
        class="absolute flex items-center justify-center rounded-sm border-2 border-accent bg-accent/20 backdrop-blur-[1px] transition-all duration-75"
        style="left:{placeholder.left}px; top:{placeholder.top}px; width:{placeholder.width}px; height:{placeholder.height}px"
      >
        <span
          class="rounded bg-accent px-2 py-0.5 text-2xs font-semibold uppercase tracking-caps text-on-accent"
          >{label}</span
        >
      </div>
    {/if}
  </div>
{/if}
