<script lang="ts">
  // The pane's close button, rendered at the end of its header row. Always shown
  // there, so it takes its room once and the header never shifts under the
  // pointer. Rendering this claims it for the header, so PaneLeaf drops its
  // corner fallback (see paneChrome).
  import { untrack } from 'svelte'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import RowAction from '../kernel/plugins/gitChanges/RowAction.svelte'
  import { layout } from '../lib/layout.svelte'
  import { usePaneChrome } from '../lib/paneChrome.svelte'

  let {
    fallback = false,
    class: className = ''
  }: {
    // PaneLeaf's corner fallback: the same button, unclaimed, floating over the
    // top-right corner of a pane with no header of its own. It overlays the
    // content rather than pushing it, so it shows only while hovering the pane.
    fallback?: boolean
    // Spacing from the header around it.
    class?: string
  } = $props()

  const chrome = usePaneChrome()

  // Claimed for as long as this header shows it. Untracked, so the count this
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

  /** Closes this pane. */
  function close(): void {
    if (!chrome) return
    layout.closeLeaf(chrome.leafId)
  }
</script>

{#if chrome}
  <div
    class={[
      'shrink-0 items-center',
      className,
      !fallback && 'flex',
      fallback &&
        'absolute top-1.5 right-1.5 z-30 hidden rounded-md bg-elevated p-0.5 shadow-md group-hover/pane:flex'
    ]}
    data-pane-controls
  >
    <RowAction icon={XIcon} title="Close pane" onclick={close} />
  </div>
{/if}
