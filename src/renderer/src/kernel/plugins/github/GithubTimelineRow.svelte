<script lang="ts">
  // One row of the thread, hung off the rail.
  //
  // The rail is a fixed gutter column rather than a border on the content: that
  // way the line is continuous whatever a row contains, and an event's icon can
  // sit centred *on* the line instead of beside it. Without that the rows read
  // as a stack of unrelated blocks, which is exactly what they looked like.
  import type { Snippet } from 'svelte'

  let {
    last = false,
    icon,
    children
  }: {
    /** The last row stops the line under its own icon instead of running on. */
    last?: boolean
    /** Drawn on the rail; absent for comments, which use the whole width. */
    icon?: Snippet
    children: Snippet
  } = $props()
</script>

<div class="flex gap-3">
  <div class="relative flex w-5 shrink-0 justify-center">
    <span
      class="absolute w-px bg-line-strong"
      class:inset-y-0={!last}
      class:top-0={last}
      class:h-4={last}
    ></span>
    {#if icon}
      <span
        class="relative mt-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-raised text-dim"
      >
        {@render icon()}
      </span>
    {/if}
  </div>

  <div class="min-w-0 flex-1 py-1.5">
    {@render children()}
  </div>
</div>
