<script lang="ts">
  // The graph's top row: the working tree, drawn as a hollow, dashed dot on the
  // checked-out commit's lane, since it is what the next commit on that lane
  // will be made from. Says how much is uncommitted, or that a merge is under
  // way; selecting it shows the changes and the commit box beside the graph.
  import { gitState } from '../state.svelte'
  import { laneColour, laneX } from './GraphCell.svelte'
  import type { GraphRow } from './graphLayout'

  let {
    height,
    graphWidth,
    lane,
    selected,
    onselect
  }: {
    height: number
    graphWidth: number
    // The checked-out commit's row, when it is loaded.
    lane: GraphRow | null
    selected: boolean
    onselect: () => void
  } = $props()

  const middle = $derived(height / 2)
  const x = $derived.by(() => {
    if (lane) return laneX(lane.column)
    return laneX(0)
  })
  const colour = $derived.by(() => {
    if (lane) return laneColour(lane.colour)
    return 'var(--color-muted)'
  })
  const changeCount = $derived(gitState.files.length)
  const label = $derived.by(() => {
    if (gitState.merge.inProgress) return 'Merge in progress'
    if (changeCount === 0) return 'Working tree clean'
    return 'Uncommitted changes'
  })
</script>

<div
  class={[
    'absolute inset-x-0 top-0 flex cursor-default items-center gap-2 pr-2 select-none',
    { 'bg-raised': selected, 'hover:bg-hover': !selected }
  ]}
  style:height="{height}px"
  role="row"
  tabindex="-1"
  aria-selected={selected}
  aria-label={label}
  onclick={onselect}
>
  <div class="shrink-0 overflow-hidden" style:width="{graphWidth}px">
    <svg width={graphWidth} {height} aria-hidden="true">
      {#if lane}
        <path
          d="M {x} {middle} V {height}"
          fill="none"
          stroke-width="1.5"
          stroke-dasharray="2 2"
          stroke={colour}
        />
      {/if}
      <circle
        cx={x}
        cy={middle}
        r="3.5"
        fill="var(--color-surface)"
        stroke-width="1.5"
        stroke-dasharray="2 1.5"
        stroke={colour}
      />
    </svg>
  </div>
  <span class="min-w-0 flex-1 truncate" class:text-default={changeCount > 0} class:text-dim={changeCount === 0}>
    {label}
  </span>
  {#if changeCount > 0}
    <span class="shrink-0 font-mono text-2xs text-dim">{changeCount}</span>
  {/if}
</div>
