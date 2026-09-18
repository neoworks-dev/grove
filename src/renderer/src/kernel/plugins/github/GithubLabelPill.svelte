<script lang="ts">
  // A label, drawn as a tint rather than a slab.
  //
  // A solid fill at full saturation made every label shout over the title it
  // annotates — five labels on a row and the title was the quietest thing in
  // it. The colour is kept, at a fraction of its strength: a wash for the
  // background, a little more for the border, and the text mixed toward the
  // theme's own foreground so it stays readable in both light and dark without
  // this having to know which is on.
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
    /** Only meaningful when interactive: an unselected pill drops to an outline. */
    selected?: boolean
    onclick?: () => void
  } = $props()

  const colour = $derived(`#${label.color.replace('#', '')}`)
  const on = $derived(!interactive || selected)

  const background = $derived(on ? `color-mix(in srgb, ${colour} 18%, transparent)` : 'transparent')
  const border = $derived(`color-mix(in srgb, ${colour} ${on ? 38 : 16}%, transparent)`)
  const text = $derived(on ? `color-mix(in srgb, ${colour} 70%, var(--text))` : 'var(--text-dim)')
</script>

{#if interactive}
  <button
    class="max-w-full shrink-0 truncate rounded-full border px-1.5 py-0 text-[10px] leading-[16px] transition-colors"
    style:background-color={background}
    style:border-color={border}
    style:color={text}
    aria-pressed={selected}
    title={label.name}
    {onclick}
  >
    {label.name}
  </button>
{:else}
  <span
    class="max-w-full shrink-0 truncate rounded-full border px-1 py-0 text-[9px] leading-[14px]"
    style:background-color={background}
    style:border-color={border}
    style:color={text}
    title={label.name}
  >
    {label.name}
  </span>
{/if}
