<script lang="ts">
  // One row of the thread. Comments take the whole width, and the line that
  // joins the thread runs between them rather than down a gutter beside them:
  // a short stretch above every row but the first, continuing through events,
  // whose icons sit on it. The line keeps one indent throughout, so the pieces
  // join up into one rail.
  import type { Snippet } from 'svelte'

  let {
    first = false,
    last = false,
    icon,
    children
  }: {
    /** The opening card has nothing above it to join to. */
    first?: boolean
    /** The last event stops the line at its own icon instead of running on. */
    last?: boolean
    /** Drawn on the line; absent for comments, which use the whole width. */
    icon?: Snippet
    children: Snippet
  } = $props()
</script>

{#if !first}
  <div class="ml-5 h-2 w-px bg-line-strong"></div>
{/if}

{#if icon}
  <div class="flex gap-2 pl-2.5">
    <div class="relative flex w-5 shrink-0 justify-center">
      <span
        class="absolute w-px bg-line-strong"
        class:inset-y-0={!last}
        class:top-0={last}
        class:h-3={last}
      ></span>
      <span
        class="relative mt-0.5 flex size-5 items-center justify-center rounded-full border border-line bg-raised text-dim"
      >
        {@render icon()}
      </span>
    </div>
    <div class="min-w-0 flex-1 py-1">
      {@render children()}
    </div>
  </div>
{:else}
  {@render children()}
{/if}
