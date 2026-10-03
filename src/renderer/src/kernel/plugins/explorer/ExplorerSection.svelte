<script lang="ts">
  // One collapsible section of the explorer, with the same header as the
  // source-control view's: caret, caps title, a count. A `fill` section takes
  // the height the others leave, for the file tree with its own scroll area;
  // the rest size to their content.
  import type { Snippet } from 'svelte'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'

  let {
    title,
    count = undefined,
    fill = false,
    open = $bindable(true),
    children
  }: {
    title: string
    count?: number
    fill?: boolean
    open?: boolean
    children: Snippet
  } = $props()
</script>

<section class={['flex min-h-0 flex-col', fill && open && 'flex-1']}>
  <div class="flex shrink-0 items-center gap-1 py-1 pr-2 pl-1 hover:bg-hover">
    <button
      class="flex min-w-0 flex-1 items-center gap-1 text-left"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <CaretRightIcon
        size={10}
        class="shrink-0 text-dim transition-transform duration-fast"
        style={open ? 'transform: rotate(90deg)' : ''}
      />
      <span class="truncate text-2xs font-semibold uppercase tracking-caps text-muted">
        {title}
      </span>
      {#if count !== undefined}
        <span class="shrink-0 rounded-full bg-raised px-1.5 font-mono text-2xs text-dim"
          >{count}</span
        >
      {/if}
    </button>
  </div>

  <!-- Hidden rather than unmounted, so a collapsed tree keeps its expanded
       folders and scroll position. -->
  <div class={['min-h-0 flex-col', open && 'flex', !open && 'hidden', fill && 'flex-1']}>
    {@render children()}
  </div>
</section>
