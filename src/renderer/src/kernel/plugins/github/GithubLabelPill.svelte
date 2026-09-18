<script lang="ts">
  // A label as GitHub draws it: the label's own colour, with the text flipped to
  // stay readable on it. The one place that decision is made, so the list, the
  // thread, the timeline and the picker cannot drift apart.
  import { labelIsDark } from './filter'
  import type { GithubLabel } from '../../../../../shared/types'

  let {
    label,
    interactive = false,
    selected = false,
    onclick
  }: {
    label: GithubLabel
    /** Renders as a button rather than a static pill. */
    interactive?: boolean
    /** Only meaningful when interactive: an unselected pill shows as an outline. */
    selected?: boolean
    onclick?: () => void
  } = $props()

  const dark = $derived(labelIsDark(label.color))
  const filled = $derived(!interactive || selected)
</script>

{#if interactive}
  <button
    class="max-w-full shrink-0 truncate rounded-full border px-2 py-0.5 text-2xs transition-colors"
    class:text-white={filled && dark}
    class:text-black={filled && !dark}
    class:text-dim={!filled}
    class:border-transparent={filled}
    class:border-line={!filled}
    class:hover:border-line-strong={!filled}
    style:background-color={filled ? `#${label.color}` : 'transparent'}
    aria-pressed={selected}
    title={label.name}
    {onclick}
  >
    {label.name}
  </button>
{:else}
  <span
    class="max-w-full shrink-0 truncate rounded-full px-2 py-0.5 text-2xs"
    class:text-white={dark}
    class:text-black={!dark}
    style:background-color="#{label.color}"
    title={label.name}
  >
    {label.name}
  </span>
{/if}
