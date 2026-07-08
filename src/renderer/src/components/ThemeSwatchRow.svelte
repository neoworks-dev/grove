<script lang="ts">
  // Overlay row for the theme picker: palette swatches + label + scheme tag.
  import type { OverlayItem } from '../lib/overlays.svelte'
  import type { ColorTheme } from '../lib/themes'

  let { item, active }: { item: OverlayItem; active: boolean } = $props()

  const theme = $derived(item.data as ColorTheme)

  function swatches(source: ColorTheme): string[] {
    const palette = source.palette
    return [
      palette.bg,
      palette.surface,
      palette.primary,
      palette.ctxGreen,
      palette.ctxBlue,
      palette.ctxViolet
    ]
  }
</script>

<span class="flex shrink-0 gap-0.5">
  {#each swatches(theme) as color (color)}
    <span class="h-3.5 w-3.5 rounded-sm border border-line/60" style="background-color: {color}"
    ></span>
  {/each}
</span>
<span class="truncate text-xs {active ? 'text-default' : 'text-muted'}">{theme.label}</span>
<span class="ml-auto shrink-0 text-2xs uppercase tracking-caps text-faint">{theme.scheme}</span>
