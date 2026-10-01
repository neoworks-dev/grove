<script lang="ts">
  // The list of agent runtimes a session can run on, as the composer's harness
  // control and the inline edit prompt both open it. One that cannot run is shown
  // disabled, with why. Anything a caller adds below the list (the composer's
  // grove mode switch) comes in as `children`.

  import Icon from '@iconify/svelte'
  import type { Snippet } from 'svelte'
  import { keepInside } from '../../../../lib/popoverFit'
  import type { HarnessInfo } from '../../../../lib/agents/types'

  let {
    harnesses,
    harness,
    boundary,
    below = false,
    onPick,
    children
  }: {
    harnesses: HarnessInfo[]
    /** The harness currently chosen, shown highlighted. */
    harness: string
    /** The element the menu stays inside, when it would open past its right edge. */
    boundary?: HTMLElement
    /** Open under the control instead of above it, when there is no room above. */
    below?: boolean
    onPick: (harness: string) => void
    children?: Snippet
  } = $props()
</script>

<div
  class="absolute left-0 z-30 w-64 rounded-md border border-line bg-elevated py-1 shadow-lg"
  class:bottom-full={!below}
  class:mb-1={!below}
  class:top-full={below}
  class:mt-1={below}
  role="menu"
  use:keepInside={boundary}
>
  {#each harnesses as entry (entry.id)}
    <button
      class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-hover disabled:opacity-50"
      class:text-default={entry.id === harness}
      class:text-dim={entry.id !== harness}
      role="menuitemradio"
      aria-checked={entry.id === harness}
      disabled={!entry.available}
      title={entry.detail ?? entry.description}
      onclick={() => onPick(entry.id)}
    >
      <Icon icon={entry.icon} class="mt-0.5 size-3.5 shrink-0" />
      <span class="flex min-w-0 flex-col items-start">
        <span>{entry.label}</span>
        {#if !entry.available}
          <span class="truncate text-2xs text-red">{entry.detail ?? 'unavailable'}</span>
        {/if}
      </span>
    </button>
  {/each}
  {#if harnesses.length === 0}
    <div class="px-2 py-1 text-2xs text-dim">No harness is mounted</div>
  {/if}
  {@render children?.()}
</div>
