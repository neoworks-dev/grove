<script lang="ts">
  // One collapsible section of the source-control view. Every section — merge
  // conflicts, staged, changes, and the ones later issues add — shares this
  // header: caret, caps title, a count, and actions that show on hover.
  import type { Snippet } from 'svelte'
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon'

  let {
    title,
    count = undefined,
    danger = false,
    open = $bindable(true),
    actions = undefined,
    children
  }: {
    title: string
    count?: number
    danger?: boolean
    open?: boolean
    actions?: Snippet
    children: Snippet
  } = $props()
</script>

<section>
  <div
    class="group sticky top-0 z-[1] flex items-center gap-1 bg-surface py-1 pr-2 pl-1 hover:bg-hover"
  >
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
      <span
        class="truncate text-2xs font-semibold uppercase tracking-caps"
        class:text-red={danger}
        class:text-muted={!danger}
      >
        {title}
      </span>
      {#if count !== undefined}
        <span class="shrink-0 rounded-full bg-raised px-1.5 font-mono text-2xs text-dim"
          >{count}</span
        >
      {/if}
    </button>
    {#if actions}
      <div
        class="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if open}
    <div class="pb-1">
      {@render children()}
    </div>
  {/if}
</section>
