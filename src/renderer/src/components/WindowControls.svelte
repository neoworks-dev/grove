<script lang="ts">
  // The top bar's right end: settings, then the window buttons. Minimise only
  // shows where the window manager has somewhere to minimise to — tiling
  // compositors ignore it — so main decides which controls are offered.
  import { onMount } from 'svelte'
  import GearSixIcon from 'phosphor-svelte/lib/GearSixIcon'
  import MinusIcon from 'phosphor-svelte/lib/MinusIcon'
  import CornersOutIcon from 'phosphor-svelte/lib/CornersOutIcon'
  import CornersInIcon from 'phosphor-svelte/lib/CornersInIcon'
  import XIcon from 'phosphor-svelte/lib/XIcon'
  import { layout } from '../lib/layout.svelte'

  let canMinimize = $state(false)
  let canFullScreen = $state(false)
  let isFullScreen = $state(false)
  const fullScreenLabel = $derived(labelForFullScreen(isFullScreen))

  // Which build this is: the commit tells an installed app from a dev checkout,
  // which share a version number.
  const versionLabel = buildLabel()
  const versionTitle = `Grove ${__APP_VERSION__}, commit ${__APP_COMMIT__}, built ${__APP_BUILT_AT__}`

  /** Version and commit, marked when running from the dev server. */
  function buildLabel(): string {
    const label = `v${__APP_VERSION__} · ${__APP_COMMIT__}`
    if (import.meta.env.DEV) {
      return `${label} · dev`
    }
    return label
  }

  /** The fullscreen button's label: what pressing it would do. */
  function labelForFullScreen(fullScreen: boolean): string {
    if (fullScreen) {
      return 'Exit full screen'
    }
    return 'Full screen'
  }

  /** Asks main which controls this window manager supports, and the fullscreen state. */
  async function refreshControls(): Promise<void> {
    const controls = await window.workbench.window.controls()
    canMinimize = controls.minimize
    canFullScreen = controls.fullScreen
    isFullScreen = controls.isFullScreen
  }

  /** Enters or leaves fullscreen and mirrors the result in the button. */
  async function toggleFullScreen(): Promise<void> {
    isFullScreen = await window.workbench.window.toggleFullScreen()
  }

  onMount(() => {
    void refreshControls()
    // Fullscreen can also change from the window manager's own keys; every
    // such change resizes the window, so that is when to re-read it.
    const onResize = (): void => void refreshControls()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })
</script>

<div class="flex items-center justify-end gap-0.5">
  <span class="mr-1 select-text font-mono text-2xs text-dim" title={versionTitle}
    >{versionLabel}</span
  >
  <button
    class="flex h-6 w-7 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-default"
    title="Settings"
    aria-label="Settings"
    onclick={() => layout.ensurePane('preferences')}
  >
    <GearSixIcon size={15} />
  </button>
  <div class="mx-1 h-3.5 w-px bg-line-faint"></div>
  {#if canMinimize}
    <button
      class="flex h-6 w-7 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-default"
      title="Minimize"
      aria-label="Minimize"
      onclick={() => void window.workbench.window.minimize()}
    >
      <MinusIcon size={15} />
    </button>
  {/if}
  {#if canFullScreen}
    <button
      class="flex h-6 w-7 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-default"
      title={fullScreenLabel}
      aria-label={fullScreenLabel}
      onclick={() => void toggleFullScreen()}
    >
      {#if isFullScreen}
        <CornersInIcon size={15} />
      {:else}
        <CornersOutIcon size={15} />
      {/if}
    </button>
  {/if}
  <button
    class="flex h-6 w-7 items-center justify-center rounded-md text-dim hover:bg-red-soft hover:text-red"
    title="Close"
    aria-label="Close"
    onclick={() => void window.workbench.window.close()}
  >
    <XIcon size={15} />
  </button>
</div>
