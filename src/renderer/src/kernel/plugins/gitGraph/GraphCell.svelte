<script lang="ts" module>
  // The lane palette: a column keeps its colour from where its branch starts
  // to where it ends.
  const PALETTE = [
    'var(--color-blue)',
    'var(--color-violet)',
    'var(--color-green)',
    'var(--color-amber)',
    'var(--color-red)',
    'var(--color-muted)'
  ]

  // Horizontal distance between columns, and the margin left of the first.
  export const LANE_WIDTH = 12
  const MARGIN = 8

  /** A lane colour by palette index. */
  export function laneColour(index: number): string {
    return PALETTE[index % PALETTE.length]
  }

  /** The width a graph of this many columns needs. */
  export function graphWidth(columns: number): number {
    return MARGIN * 2 + Math.max(0, columns - 1) * LANE_WIDTH
  }
</script>

<script lang="ts">
  // One row of the commit graph: the lines through it and the commit's dot. A
  // merge commit is drawn hollow; the commit the worktree has checked out gets
  // a ring.
  import type { GraphLine, GraphRow } from './graphLayout'

  let {
    row,
    width,
    height,
    merge,
    head
  }: {
    row: GraphRow
    width: number
    height: number
    merge: boolean
    head: boolean
  } = $props()

  const middle = $derived(height / 2)

  /** A column's x coordinate. */
  function x(column: number): number {
    return MARGIN + column * LANE_WIDTH
  }

  /** A line from one column at `top` to another at `bottom`, bending smoothly between. */
  function path(line: GraphLine, top: number, bottom: number): string {
    if (line.from === line.to) return `M ${x(line.from)} ${top} V ${bottom}`
    const bend = (top + bottom) / 2
    return `M ${x(line.from)} ${top} C ${x(line.from)} ${bend}, ${x(line.to)} ${bend}, ${x(line.to)} ${bottom}`
  }
</script>

<svg class="shrink-0" {width} {height} aria-hidden="true">
  {#each row.above as line, index (index)}
    <path d={path(line, 0, middle)} fill="none" stroke-width="1.5" stroke={laneColour(line.colour)} />
  {/each}
  {#each row.below as line, index (index)}
    <path
      d={path(line, middle, height)}
      fill="none"
      stroke-width="1.5"
      stroke={laneColour(line.colour)}
    />
  {/each}
  {#if head}
    <circle cx={x(row.column)} cy={middle} r="6" fill="none" stroke={laneColour(row.colour)} />
  {/if}
  {#if merge}
    <circle
      cx={x(row.column)}
      cy={middle}
      r="3"
      fill="var(--color-surface)"
      stroke-width="1.5"
      stroke={laneColour(row.colour)}
    />
  {:else}
    <circle cx={x(row.column)} cy={middle} r="3.5" fill={laneColour(row.colour)} />
  {/if}
</svg>
