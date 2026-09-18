<script lang="ts">
  // A label as GitHub draws it: the label's own colour, with the text flipped to
  // stay readable on it. The one place that decision is made, so the list, the
  // thread, the timeline and the picker cannot drift apart.
  //
  // Deliberately smaller than body text. At the shared 2xs a pill sat within a
  // pixel of the title beside it and the two competed; a label is an annotation
  // on a title, and should read as one. The picker's pills are a step larger,
  // because there they are the thing being clicked.
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
    class="max-w-full shrink-0 truncate rounded-full border px-2 py-0.5 text-[10px] leading-4 transition-colors"
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
    class="max-w-full shrink-0 truncate rounded-full px-1.5 py-0 text-[9px] font-medium leading-[15px]"
    class:text-white={dark}
    class:text-black={!dark}
    style:background-color="#{label.color}"
    title={label.name}
  >
    {label.name}
  </span>
{/if}
