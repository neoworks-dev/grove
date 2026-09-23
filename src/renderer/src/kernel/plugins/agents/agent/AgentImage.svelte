<script lang="ts">
  // An image in the transcript: a thumbnail where it occurred, and the image at
  // full size over the whole window on a click. Escape or a click anywhere
  // closes it again.

  import { portal } from '@neoworks-dev/ui'

  let {
    src,
    alt
  }: {
    src: string
    alt: string
  } = $props()

  let open = $state(false)

  /** Closes the full-size view on Escape, and only while it is open. */
  function onKeyDown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    open = false
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<button
  class="block shrink-0 overflow-hidden rounded border border-line"
  title="Open full size"
  onclick={() => (open = true)}
>
  <img class="max-h-32 max-w-full" {src} {alt} />
</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal
    class="fixed inset-0 z-modal flex cursor-zoom-out items-center justify-center bg-black/70 p-8"
    onclick={() => (open = false)}
  >
    <img class="max-h-full max-w-full rounded shadow-overlay" {src} {alt} />
  </div>
{/if}
