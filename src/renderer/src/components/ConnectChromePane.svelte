<script lang="ts">
  // "Connect Chrome": installs the browser extension's native-messaging host
  // for a Chromium-family browser, on the user's word only, and says how to
  // load the extension. Once both are in place the extension hands tabs to a
  // worktree's agents (#357, #358).
  import { onMount } from 'svelte'
  import type { BrowserConnectorStatus, BrowserHostStatus } from '../../../shared/browserHost'
  import { store } from '../lib/store.svelte'
  import PaneControls from './PaneControls.svelte'

  let status = $state<BrowserConnectorStatus | null>(null)
  let busy = $state(false)
  let copied = $state(false)

  const anyInstalled = $derived(status !== null && status.browsers.some((browser) => browser.installed))

  /** Reads what is installed where. */
  async function refresh(): Promise<void> {
    try {
      status = await window.workbench.browserHost.status()
    } catch (error) {
      store.setError((error as Error).message)
    }
  }

  /** Runs an install or remove, and shows the status it leaves. */
  async function change(action: () => Promise<BrowserConnectorStatus>): Promise<void> {
    busy = true
    try {
      status = await action()
    } catch (error) {
      store.setError((error as Error).message)
    } finally {
      busy = false
    }
  }

  /** Installs the host for one browser. */
  function connect(browser: BrowserHostStatus): void {
    void change(() => window.workbench.browserHost.install(browser.id))
  }

  /** Removes the host for one browser. */
  function disconnect(browser: BrowserHostStatus): void {
    void change(() => window.workbench.browserHost.remove(browser.id))
  }

  /** Copies the extension's folder, to paste into the browser's "Load unpacked" dialog. */
  async function copyExtensionPath(): Promise<void> {
    if (!status) return
    await navigator.clipboard.writeText(status.extensionPath)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  /** Opens the extension's folder in the file manager. */
  function revealExtension(): void {
    window.workbench.browserHost.revealExtension().catch((error: Error) => store.setError(error.message))
  }

  onMount(refresh)
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
    <span class="text-xs font-semibold text-default">Connect Chrome</span>
    <PaneControls />
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    <p class="mb-3 text-xs text-dim">
      Hand a tab in your own browser to a worktree's agents. They navigate, click and take screenshots in it
      while you watch. Works with Chrome, Chromium, Edge and Brave.
    </p>

    {#if status && !status.supported}
      <p class="text-xs text-amber">Connecting a browser is only supported on Linux and macOS for now.</p>
    {:else if status}
      <h3 class="mb-1 text-2xs font-semibold uppercase tracking-caps text-dim">1 · Connect the browser</h3>
      <p class="mb-2 text-2xs text-dim">
        Lets the browser start Grove's connector when the extension asks for it. Nothing is installed until you
        click Connect.
      </p>
      {#each status.browsers as browser (browser.id)}
        <div class="flex items-center gap-3 border-b border-line/50 py-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-xs text-default">{browser.label}</span>
              {#if browser.installed}
                <span class="rounded bg-green-soft px-1.5 text-2xs text-green">connected</span>
              {:else if !browser.detected}
                <span class="text-2xs text-faint">not found</span>
              {/if}
            </div>
            <p class="truncate font-mono text-2xs text-faint" title={browser.manifestPath}>{browser.manifestPath}</p>
          </div>
          {#if browser.installed}
            <button
              class="shrink-0 rounded-md border border-line px-2.5 py-1 text-2xs text-red hover:bg-hover disabled:opacity-40"
              disabled={busy}
              onclick={() => disconnect(browser)}
            >
              Remove
            </button>
          {:else}
            <button
              class="shrink-0 rounded-md border border-line px-2.5 py-1 text-2xs text-default hover:bg-hover disabled:opacity-40"
              disabled={busy}
              onclick={() => connect(browser)}
            >
              Connect
            </button>
          {/if}
        </div>
      {/each}

      <h3 class="mb-1 mt-5 text-2xs font-semibold uppercase tracking-caps text-dim">2 · Load the extension</h3>
      {#if anyInstalled}
        <ol class="mb-2 list-decimal space-y-0.5 pl-4 text-2xs text-dim">
          <li>Open <span class="font-mono text-muted">chrome://extensions</span> (or your browser's Extensions page).</li>
          <li>Turn on <span class="text-muted">Developer mode</span>.</li>
          <li>Click <span class="text-muted">Load unpacked</span> and choose this folder:</li>
        </ol>
        <div class="flex items-center gap-2 rounded-md border border-line bg-input px-2 py-1.5">
          <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted" title={status.extensionPath}>
            {status.extensionPath}
          </span>
          <button class="shrink-0 text-2xs text-dim hover:text-default" onclick={copyExtensionPath}>
            {#if copied}Copied{:else}Copy{/if}
          </button>
          <button class="shrink-0 text-2xs text-dim hover:text-default" onclick={revealExtension}>Show</button>
        </div>
        <p class="mt-2 text-2xs text-dim">
          Then click Grove's icon in the toolbar and pair it; Grove asks you to approve it once. The extension's id
          is <span class="font-mono text-faint">{status.extensionId}</span>.
        </p>
      {:else}
        <p class="text-2xs text-dim">Connect a browser first; that puts the extension where you can load it.</p>
      {/if}
    {/if}
  </div>
</div>
