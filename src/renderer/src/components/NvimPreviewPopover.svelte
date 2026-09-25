<script lang="ts">
  // A preview nvim handed to grove (see lib/nvim/previews.ts), drawn at the
  // cursor: hover docs and signature help as rendered markdown, Inspect and
  // other plain previews as text, and a line's diagnostics with the quick fixes
  // the servers offer for them. nvim still owns when it closes; this only asks
  // (onDismiss) and applies fixes through onFix.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon'
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon'
  import LightbulbIcon from 'phosphor-svelte/lib/LightbulbIcon'
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon'
  import WrenchIcon from 'phosphor-svelte/lib/WrenchIcon'
  import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon'
  import { renderMarkdown } from '../lib/markdown'
  import { highlightCodeFences } from '../lib/markdownHighlight'
  import { floatingCodeScrollbars } from '../lib/markdownScrollbars'
  import { placePopover, type NvimPreview } from '../lib/nvim/previews'

  let {
    preview,
    anchor,
    pane,
    onFix,
    onDismiss
  }: {
    preview: NvimPreview
    // The cursor cell's top-left and the line height, in pane pixels.
    anchor: { left: number; top: number; lineHeight: number }
    pane: { width: number; height: number }
    onFix: (index: number) => void
    onDismiss: () => void
  } = $props()

  // Gap between the popover and the line it belongs to.
  const GAP = 4

  let width = $state(0)
  let height = $state(0)
  const placement = $derived(placePopover(anchor, { width, height }, pane, GAP))

  /** Severity label for screen readers and the icon's title. */
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
  class="absolute z-overlay flex w-max max-w-[min(36rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-line bg-elevated text-xs text-default shadow-2xl"
  style="left:{placement.left}px;top:{placement.top}px"
  bind:clientWidth={width}
  bind:clientHeight={height}
  role="dialog"
  aria-label="Preview"
  tabindex="-1"
  onmousedown={(event) => event.stopPropagation()}
  onpointerdown={(event) => event.stopPropagation()}
  onwheel={(event) => event.stopPropagation()}
  onkeydown={onKeyDown}
>
  <FloatingScrollbar class="max-h-80 min-h-0">
    {#if preview.kind === 'markdown'}
      <div
        class="agent-markdown prose max-w-none px-3 py-2 text-xs text-default"
        use:floatingCodeScrollbars
        use:highlightCodeFences
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderMarkdown(preview.text)}
      </div>
    {:else if preview.kind === 'text'}
      <pre class="whitespace-pre-wrap px-3 py-2 font-mono text-xs">{preview.text}</pre>
    {:else}
      <ul class="flex flex-col gap-1.5 px-3 py-2">
        {#each preview.diagnostics as diagnostic, index (index)}
          <li class="flex items-start gap-2">
            <span
              class="mt-px shrink-0"
              class:text-red={diagnostic.severity === 1}
              class:text-amber={diagnostic.severity === 2}
              class:text-blue={diagnostic.severity === 3}
              class:text-dim={diagnostic.severity >= 4}
              title={severityName(diagnostic.severity)}
              aria-label={severityName(diagnostic.severity)}
            >
              {#if diagnostic.severity === 1}
                <XCircleIcon size={14} weight="fill" />
              {:else if diagnostic.severity === 2}
                <WarningIcon size={14} weight="fill" />
              {:else if diagnostic.severity === 3}
                <InfoIcon size={14} weight="fill" />
              {:else}
                <LightbulbIcon size={14} weight="fill" />
              {/if}
            </span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap leading-snug">{diagnostic.message}</span>
            {#if diagnostic.source || diagnostic.code}
              <span class="shrink-0 pl-2 font-mono text-2xs leading-snug text-dim">
                {#if diagnostic.source}{diagnostic.source}{/if}{#if diagnostic.source && diagnostic.code}&nbsp;{/if}{#if diagnostic.code}<span class="text-faint">{diagnostic.code}</span>{/if}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if preview.fixes === null}
        <div class="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-dim">
          <CircleNotchIcon size={12} class="animate-spin" />
          Looking for fixes…
        </div>
      {:else if preview.fixes.length > 0}
        <div class="flex flex-col border-t border-line py-1">
          {#each preview.fixes as fix, index (index)}
            <button
              class="flex cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-hover"
              onclick={() => onFix(index + 1)}
            >
              <WrenchIcon size={12} class="shrink-0 text-accent" />
              <span class="min-w-0 truncate">{fix}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </FloatingScrollbar>
</div>
