<script lang="ts">
  // A line's diagnostics, handed over by nvim (see lib/nvim/previews.ts) so the
  // quick fixes the servers offer can sit under them, clickable. Drawn to read
  // like the nvim floats around it: the pane's font at its zoom, one cell per
  // line, the float background, a dot and the message in the severity's
  // colour. nvim still owns when it closes; this only asks (onDismiss) and
  // applies fixes through onFix.
  import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon'
  import { placePopover, type NvimPreview } from '../lib/nvim/previews'

  let {
    preview,
    anchor,
    pane,
    font,
    onFix,
    onDismiss
  }: {
    preview: NvimPreview
    // The cursor cell's top-left and the line height, in pane pixels.
    anchor: { left: number; top: number; lineHeight: number }
    pane: { width: number; height: number }
    // nvim's font in this pane: family, size at the pane's zoom, cell height.
    font: { family: string; sizePx: number; lineHeight: number }
    onFix: (index: number) => void
    onDismiss: () => void
  } = $props()

  // The frame's padding, as for the nvim floats Grove frames (NvimPane's
  // FLOAT_PADDING): the text starts on the cursor's column, the frame outside it.
  const PADDING = 8

  let width = $state(0)
  let height = $state(0)
  const placement = $derived(
    placePopover({ ...anchor, left: anchor.left - PADDING }, { width, height }, pane, 0)
  )

  /** Severity label for screen readers and the dot's title. */
  function severityName(severity: number): string {
    if (severity === 1) return 'Error'
    if (severity === 2) return 'Warning'
    if (severity === 3) return 'Info'
    return 'Hint'
  }

  /** Escape closes the popover while focus is inside it (after clicking in). */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onDismiss()
  }
</script>

<!-- The popover swallows its own pointer events so a click to select text or
     press a fix never lands on the canvas underneath and moves nvim's cursor,
     which would close it. -->
<div
  class="absolute z-overlay w-max max-w-[calc(100%-1rem)] rounded-lg border border-line bg-elevated text-default shadow-2xl"
  style="left:{placement.left}px;top:{placement.top}px;padding:{PADDING}px;font-family:{font.family};font-size:{font.sizePx}px;line-height:{font.lineHeight}px"
  bind:clientWidth={width}
  bind:clientHeight={height}
  role="dialog"
  aria-label="Line diagnostics"
  tabindex="-1"
  onmousedown={(event) => event.stopPropagation()}
  onpointerdown={(event) => event.stopPropagation()}
  onwheel={(event) => event.stopPropagation()}
  onkeydown={onKeyDown}
>
  {#each preview.diagnostics as diagnostic, index (index)}
    <div
      class="flex whitespace-pre-wrap"
      class:text-red={diagnostic.severity === 1}
      class:text-amber={diagnostic.severity === 2}
      class:text-blue={diagnostic.severity === 3}
      class:text-dim={diagnostic.severity >= 4}
    >
      <span class="shrink-0" title={severityName(diagnostic.severity)}>●&nbsp;</span>
      <span class="min-w-0">
        {diagnostic.message}{#if diagnostic.source || diagnostic.code}<span class="text-dim"
            >{#if diagnostic.source}&nbsp;{diagnostic.source}{/if}{#if diagnostic.code}&nbsp;{diagnostic.code}{/if}</span
          >{/if}
      </span>
    </div>
  {/each}
  {#if preview.fixes === null}
    <div class="text-dim">&nbsp;&nbsp;Looking for fixes…</div>
  {:else}
    {#each preview.fixes as fix, index (index)}
      <button
        class="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center rounded px-1 text-left hover:bg-hover"
        onclick={() => onFix(index + 1)}
      >
        <WrenchIcon size={font.sizePx - 2} class="shrink-0 text-accent" />
        <span class="min-w-0 truncate">&nbsp;{fix}</span>
      </button>
    {/each}
  {/if}
</div>
