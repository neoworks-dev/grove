<script lang="ts">
  // A plugin's page pane: a page from its bundle in a frame that can run
  // scripts and nothing else — no same-origin access to Grove, and main serves
  // the page under a policy with no network. The page talks to its plugin's
  // worker only, through the host; each mounted copy is one page instance.
  import { onDestroy } from 'svelte'
  import { store } from '../lib/store.svelte'
  import { usePaneChrome } from '../lib/paneChrome.svelte'
  import PaneControls from '../components/PaneControls.svelte'
  import { pluginHost, type PageInstanceConnection } from './host.svelte'
  import { currentPageTheme, replayPageKey, PAGE_CONTROLS_INSET } from './pageFrame'
  import type { PanePageMessage } from '../../../shared/plugins'

  let { paneTypeId }: { paneTypeId: string } = $props()

  const pageUrl = $derived(pluginHost.pagePaneUrl(paneTypeId))
  // A page can't render Grove's pane controls itself, so they are drawn here,
  // over the right end of its first row, and the page is told to leave room.
  // Where nothing provides them (the bottom panel has its own), no room.
  const controlsInset = usePaneChrome() ? PAGE_CONTROLS_INSET : 0

  let frameEl = $state<HTMLIFrameElement>()
  // Set once the page has said it is listening; nothing is sent before then.
  let pageReady = $state(false)
  let connection: PageInstanceConnection | null = null

  // The page announces itself, sends its messages and passes up keys it
  // leaves alone; only messages from this frame count.
  $effect(() => {
    const listener = (event: MessageEvent): void => {
      if (!frameEl || event.source !== frameEl.contentWindow) return
      const message = event.data as PanePageMessage
      if (message?.type === 'grove.pane.ready') onReady()
      else if (message?.type === 'grove.pane.message') connection?.send(message.data)
      else if (message?.type === 'grove.pane.key') replayPageKey(frameEl, message)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  })

  // Follow Grove's theme while the page is open.
  $effect(() => {
    void store.activeTheme
    if (!pageReady) return
    post({ type: 'grove.pane.theme', theme: currentPageTheme() })
  })

  /**
   * The page loaded (or reloaded): a fresh instance for the worker, since
   * whatever the old page held is gone.
   */
  function onReady(): void {
    connection?.close()
    post({ type: 'grove.pane.init', theme: currentPageTheme(), controlsInset })
    pageReady = true
    connection = pluginHost.openPageInstance(paneTypeId, (data) =>
      post({ type: 'grove.pane.message', data })
    )
  }

  /** Posts a message to the page. Its origin is opaque, hence '*'. */
  function post(message: PanePageMessage): void {
    frameEl?.contentWindow?.postMessage(message, '*')
  }

  onDestroy(() => connection?.close())
</script>

<div class="relative min-h-0 flex-1">
  {#if pageUrl}
    <iframe
      bind:this={frameEl}
      src={pageUrl}
      title={paneTypeId}
      sandbox="allow-scripts"
      class="block h-full w-full border-0 bg-surface"
    ></iframe>
    {#if controlsInset}
      <PaneControls class="absolute top-2 right-3 z-10" />
    {/if}
  {:else}
    <div class="flex h-full items-center justify-center p-6 text-center text-xs text-dim">
      This pane's plugin is not available.
    </div>
  {/if}
</div>
