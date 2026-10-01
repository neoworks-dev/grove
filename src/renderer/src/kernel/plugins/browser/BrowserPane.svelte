<script lang="ts">
  // The worktree's browser preview: its dev server in a <webview>, with
  // DevTools a click away.
  //
  // The page is handed to the main process once it is ready, and from then on
  // every agent in the worktree can drive it — what they do shows on the
  // activity line, and happens in the page in front of the user. Pointing at an
  // element hands it to the agent pane's composer.
  //
  // One page per worktree: switching worktrees swaps the page, and comes back
  // to the address the other one was last on.
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft'
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight'
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise'
  import Crosshair from 'phosphor-svelte/lib/Crosshair'
  import Bug from 'phosphor-svelte/lib/Bug'
  import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut'
  import GlobeSimple from 'phosphor-svelte/lib/GlobeSimple'
  import { untrack } from 'svelte'
  import PaneControls from '../../../components/PaneControls.svelte'
  import { insertTextIntoComposer, store } from '../../../lib/store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import { browserState } from './browserState.svelte'
  import { addressOf, describePickedElement, startingUrl } from './browserAddress'

  /** The parts of Electron's <webview> the pane uses. */
  interface WebviewElement extends HTMLElement {
    getWebContentsId(): number
    getURL(): string
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    reload(): void
    loadURL(url: string): Promise<void>
    openDevTools(): void
    closeDevTools(): void
    isDevToolsOpened(): boolean
  }

  /** Must match BROWSER_PARTITION in the main process. */
  const PARTITION = 'persist:grove-browser'

  const worktreeId = $derived(store.selectedWorktreeId)
  const services = $derived.by(() => {
    if (!worktreeId) return []
    return store.services[worktreeId] || []
  })

  // The address each worktree's page was created with, held while the page
  // lives: later navigation goes through the page itself, and must not
  // rebuild it by changing where it starts.
  let createdWith = $state<Record<string, string>>({})

  const initialUrl = $derived.by(() => {
    if (!worktreeId) return ''
    const created = createdWith[worktreeId]
    if (created) return created
    return startingUrl(browserState.urls[worktreeId], services)
  })

  let webview = $state<WebviewElement | null>(null)
  let addressText = $state('')
  let editingAddress = $state(false)
  let canGoBack = $state(false)
  let canGoForward = $state(false)
  let loading = $state(false)
  let picking = $state(false)
  let failure = $state('')

  const activity = $derived.by(() => {
    if (!worktreeId) return null
    return browserState.activity[worktreeId] ?? null
  })

  $effect(() => {
    if (editingAddress) return
    addressText = initialUrl
  })

  /**
   * Builds the page for a worktree inside `host`, and hands it to the main
   * process once it is ready; returns the teardown.
   */
  function mountWebview(host: HTMLElement, forWorktree: string, url: string): () => void {
    const element = document.createElement('webview') as WebviewElement
    element.setAttribute('partition', PARTITION)
    element.setAttribute('src', url)
    element.className = 'h-full w-full bg-white'
    let attachedId: number | null = null

    const onReady = (): void => {
      if (attachedId !== null) return
      attachedId = element.getWebContentsId()
      void window.workbench.browser.attach(forWorktree, attachedId)
    }
    const onNavigate = (): void => {
      const current = element.getURL()
      browserState.remember(forWorktree, current)
      if (!editingAddress) addressText = current
      canGoBack = element.canGoBack()
      canGoForward = element.canGoForward()
      failure = ''
    }
    const onStart = (): void => {
      loading = true
    }
    const onStop = (): void => {
      loading = false
    }
    const onFail = (event: Event): void => {
      const details = event as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean }
      // -3 is an aborted load: a redirect or a newer navigation, not a failure.
      if (!details.isMainFrame || details.errorCode === -3) return
      failure = `${details.errorDescription} (${details.errorCode})`
    }

    element.addEventListener('dom-ready', onReady)
    element.addEventListener('did-navigate', onNavigate)
    element.addEventListener('did-navigate-in-page', onNavigate)
    element.addEventListener('did-start-loading', onStart)
    element.addEventListener('did-stop-loading', onStop)
    element.addEventListener('did-fail-load', onFail)
    host.appendChild(element)
    webview = element
    // Untracked: the attachment would otherwise rebuild the page over its own bookkeeping.
    untrack(() => {
      createdWith = { ...createdWith, [forWorktree]: url }
    })

    return () => {
      if (attachedId !== null) void window.workbench.browser.detach(forWorktree, attachedId)
      element.remove()
      if (webview === element) webview = null
      const remaining = { ...createdWith }
      delete remaining[forWorktree]
      createdWith = remaining
    }
  }

  /** The attachment that keeps a page in the host for the selected worktree and address. */
  function pageHost(forWorktree: string, url: string): (host: HTMLElement) => () => void {
    return (host) => mountWebview(host, forWorktree, url)
  }

  // ── Toolbar ─────────────────────────────────────────────────────

  /** Opens what the address bar says. */
  function go(): void {
    editingAddress = false
    const url = addressOf(addressText)
    if (!url || !worktreeId) return
    failure = ''
    if (!webview) {
      browserState.remember(worktreeId, url)
      return
    }
    webview.loadURL(url).catch(() => {})
  }

  function onAddressKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      go()
      return
    }
    if (event.key === 'Escape') {
      editingAddress = false
      addressText = webview ? webview.getURL() : initialUrl
      ;(event.currentTarget as HTMLInputElement).blur()
    }
  }

  function toggleDevTools(): void {
    if (!webview) return
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools()
      return
    }
    webview.openDevTools()
  }

  /**
   * Lets the user point at an element in the page, then hands it to the agent
   * pane's composer. A second press cancels.
   */
  async function pointAtElement(): Promise<void> {
    if (!worktreeId) return
    if (picking) {
      await window.workbench.browser.cancelPick(worktreeId)
      return
    }
    picking = true
    try {
      const picked = await window.workbench.browser.pick(worktreeId)
      if (!picked) return
      layout.ensurePane('agent')
      insertTextIntoComposer(describePickedElement(picked))
    } catch (error) {
      failure = (error as Error).message
    } finally {
      picking = false
    }
  }

  function openExternally(): void {
    if (!webview) return
    void window.workbench.openExternal(webview.getURL())
  }

  /** Opens a service's preview address. */
  function openService(url: string): void {
    addressText = url
    go()
  }
</script>

<div class="flex h-full min-w-0 flex-col" data-testid="browser-pane">
  <div class="flex shrink-0 items-center gap-0.5 px-1.5 py-1">
    <button
      class="rounded p-1 text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Back"
      aria-label="Back"
      disabled={!canGoBack}
      onclick={() => webview?.goBack()}
    >
      <ArrowLeft size={13} />
    </button>
    <button
      class="rounded p-1 text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Forward"
      aria-label="Forward"
      disabled={!canGoForward}
      onclick={() => webview?.goForward()}
    >
      <ArrowRight size={13} />
    </button>
    <button
      class="rounded p-1 text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Reload"
      aria-label="Reload"
      disabled={!webview}
      onclick={() => webview?.reload()}
    >
      <ArrowClockwise size={13} class={loading ? 'animate-spin' : ''} />
    </button>
    <input
      class="mx-1 h-6 min-w-0 flex-1 rounded border border-line bg-surface px-2 font-mono text-2xs text-default outline-none focus:border-accent"
      placeholder="Dev server address, e.g. localhost:3000"
      aria-label="Address"
      spellcheck="false"
      bind:value={addressText}
      onfocus={() => (editingAddress = true)}
      onblur={() => (editingAddress = false)}
      onkeydown={onAddressKeyDown}
    />
    <button
      class="rounded p-1 enabled:hover:bg-hover disabled:opacity-40"
      class:text-amber={picking}
      class:text-dim={!picking}
      class:enabled:hover:text-default={!picking}
      title={picking ? 'Pointing at an element: click one in the page, Escape to stop' : 'Point at an element to hand it to the agent'}
      aria-label="Point at an element"
      aria-pressed={picking}
      disabled={!webview}
      onclick={() => void pointAtElement()}
    >
      <Crosshair size={13} />
    </button>
    <button
      class="rounded p-1 text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="DevTools"
      aria-label="DevTools"
      disabled={!webview}
      onclick={toggleDevTools}
    >
      <Bug size={13} />
    </button>
    <button
      class="rounded p-1 text-dim enabled:hover:bg-hover enabled:hover:text-default disabled:opacity-40"
      title="Open in your browser"
      aria-label="Open in your browser"
      disabled={!webview}
      onclick={openExternally}
    >
      <ArrowSquareOut size={13} />
    </button>
    <PaneControls class="ml-1" />
  </div>

  {#if activity}
    <div
      class="flex shrink-0 items-center gap-1.5 border-y border-blue/30 bg-blue/10 px-2.5 py-1 text-2xs text-blue"
      data-testid="browser-activity"
    >
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-blue"></span>
      <span class="min-w-0 truncate">Agent: {activity.text}</span>
    </div>
  {/if}

  {#if failure}
    <div class="shrink-0 border-y border-red/30 bg-red-soft px-2.5 py-1 text-2xs text-red">
      Could not load the page: {failure}
    </div>
  {/if}

  <div class="relative min-h-0 flex-1">
    {#if !worktreeId}
      <p class="px-3 py-3 text-xs text-dim">Select a worktree.</p>
    {:else if !initialUrl}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <GlobeSimple size={22} class="text-dim" />
        <p class="max-w-72 text-xs text-dim">
          Type the address of this worktree’s dev server above. Agents in the worktree can then open
          it, click through it and read its console.
        </p>
        {#each services.filter((service) => service.previewUrl) as service (service.name)}
          <button
            class="rounded border border-line px-2 py-1 font-mono text-2xs text-muted hover:bg-hover hover:text-default"
            onclick={() => openService(service.previewUrl ?? '')}
          >
            {service.name} · {service.previewUrl}
          </button>
        {/each}
      </div>
    {:else}
      {#key worktreeId}
        <div class="absolute inset-0" {@attach pageHost(worktreeId, initialUrl)}></div>
      {/key}
    {/if}
  </div>
</div>
