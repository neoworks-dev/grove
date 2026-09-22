<script lang="ts">
  // The pane's title-bar controls, rendered at the end of its header row: switch
  // what the pane shows, split it, maximize it, close it. They show while the
  // pointer is over the pane. Rendering this claims them for the header, so
  // PaneLeaf drops its corner fallback (see paneChrome).
  import { untrack } from 'svelte'
  import { portal } from '@neoworks-dev/ui'
  import AppWindowIcon from 'phosphor-svelte/lib/AppWindowIcon'
  import ArrowsInSimpleIcon from 'phosphor-svelte/lib/ArrowsInSimpleIcon'
  import ArrowsOutSimpleIcon from 'phosphor-svelte/lib/ArrowsOutSimpleIcon'
  import SquareSplitHorizontalIcon from 'phosphor-svelte/lib/SquareSplitHorizontalIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import PanePicker from './PanePicker.svelte'
  import RowAction from '../kernel/plugins/gitChanges/RowAction.svelte'
  import { keymap } from '../lib/keymap.svelte'
  import { layout } from '../lib/layout.svelte'
  import { usePaneChrome } from '../lib/paneChrome.svelte'

  let {
    fallback = false,
    class: className = ''
  }: {
    // PaneLeaf's corner fallback: the same controls, unclaimed, floating over
    // the top-right corner of a pane with no header of its own.
    fallback?: boolean
    // Spacing from the header around it; applied only while they show, so a
    // hidden set takes no room at all.
    class?: string
  } = $props()

  const chrome = usePaneChrome()

  // Claimed for as long as this header shows them. Untracked, so the count this
  // writes is not also something the effect reruns on.
  $effect(() => {
    if (!chrome || fallback) return
    untrack(() => {
      chrome.claims += 1
    })
    return () => {
      untrack(() => {
        chrome.claims -= 1
      })
    }
  })

  let pickerOpen = $state(false)
  let pickerAnchor = $state<HTMLElement>()
  let pickerEl = $state<HTMLElement>()
  let pickerPosition = $state({ top: 0, right: 0 })

  const maximized = $derived(
    chrome !== null && layout.focusMode && keymap.activeLeafId === chrome.leafId
  )

  /** Focuses this pane, so the layout's focus-relative actions act on it. */
  function focusThisPane(): void {
    if (!chrome) return
    keymap.focusPane(chrome.leafId)
  }

  /** Opens the pane-type picker under its button, in viewport coordinates. */
  function togglePicker(): void {
    if (pickerOpen) {
      pickerOpen = false
      return
    }
    if (!pickerAnchor) return
    const rect = pickerAnchor.getBoundingClientRect()
    pickerPosition = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
    pickerOpen = true
  }

  /** Closes the picker when a press lands outside it and its button. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!pickerOpen) return
    if (!(event.target instanceof Node)) return
    if (pickerEl?.contains(event.target) || pickerAnchor?.contains(event.target)) return
    pickerOpen = false
  }

  /** Turns this pane into another type. */
  function pick(paneTypeId: string): void {
    pickerOpen = false
    if (!chrome || paneTypeId === chrome.paneTypeId()) return
    layout.setLeafType(chrome.leafId, paneTypeId)
  }

  /** Opens a copy of this pane beside it. */
  function split(): void {
    focusThisPane()
    layout.splitFocused('row')
  }

  /** Fills the window with this pane, or gives the other panes back. */
  function toggleMaximize(): void {
    focusThisPane()
    layout.toggleFocusMode()
  }

  /** Closes this pane. */
  function close(): void {
    if (!chrome) return
    layout.closeLeaf(chrome.leafId)
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

{#if chrome}
  <!-- Shown while the pointer is over the pane, or while the picker is open.
       Hidden rather than transparent, so the header keeps its full width. -->
  <div
    class="pane-controls hidden shrink-0 items-center gap-0.5 group-hover/pane:flex {className}"
    class:!flex={pickerOpen}
    class:absolute={fallback}
    class:right-1.5={fallback}
    class:top-1.5={fallback}
    class:z-30={fallback}
    class:rounded-md={fallback}
    class:bg-elevated={fallback}
    class:p-0.5={fallback}
    class:shadow-md={fallback}
    data-pane-controls
  >
    <span bind:this={pickerAnchor} class="flex">
      <RowAction icon={AppWindowIcon} title="Change pane" onclick={togglePicker} />
    </span>
    <RowAction icon={SquareSplitHorizontalIcon} title="Split pane" onclick={split} />
    {#if maximized}
      <RowAction icon={ArrowsInSimpleIcon} title="Restore panes" onclick={toggleMaximize} />
    {:else}
      <RowAction icon={ArrowsOutSimpleIcon} title="Maximize pane" onclick={toggleMaximize} />
    {/if}
    <RowAction icon={XIcon} title="Close pane" onclick={close} />
  </div>

  {#if pickerOpen}
    <div
      use:portal
      bind:this={pickerEl}
      class="fixed z-50"
      style:top="{pickerPosition.top}px"
      style:right="{pickerPosition.right}px"
    >
      <PanePicker currentTypeId={chrome.paneTypeId()} onpick={pick} />
    </div>
  {/if}
{/if}

<style>
  /* Fade and slide in as the controls go from display:none to shown. The
     starting style is what they animate from on the frame they first appear;
     hiding stays instant, so leaving a pane never leaves them hanging. */
  .pane-controls {
    transition:
      opacity 140ms ease-out,
      translate 140ms ease-out;
  }

  @starting-style {
    .pane-controls {
      opacity: 0;
      translate: 4px 0;
    }
  }
</style>
