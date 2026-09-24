<script lang="ts">
  // A 3D model on a grid, orbited with the mouse: left-drag turns, right-drag
  // pans, wheel zooms. The scene lives in ModelStage; this mounts it, keeps it
  // sized to the pane, and reloads the model when the file changes on disk —
  // keeping the camera where it was, since that is the same model re-exported.
  import { onDestroy, onMount } from 'svelte'
  import { ModelStage, type ModelStats } from '../../lib/modelStage'
  import { extensionOf } from '../../lib/media'
  import MediaToolbar from './MediaToolbar.svelte'
  import MediaToolButton from './MediaToolButton.svelte'

  let { src, path }: { src: string; path: string } = $props()

  let canvasEl = $state<HTMLCanvasElement>()
  let stage = $state.raw<ModelStage | null>(null)
  let stats = $state<ModelStats | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let wireframe = $state(false)
  // The file whose model is on stage; a reload of the same file keeps the view.
  let loadedPath: string | null = null

  onMount(() => {
    if (!canvasEl) return
    stage = new ModelStage(canvasEl, themeColors())
  })

  onDestroy(() => {
    stage?.dispose()
  })

  $effect(() => {
    if (!stage) return
    void loadInto(stage, src, path)
  })

  $effect(() => {
    if (!canvasEl || !stage) return
    const target = canvasEl
    const currentStage = stage
    const observer = new ResizeObserver(() => {
      currentStage.resize(target.clientWidth, target.clientHeight)
    })
    observer.observe(target)
    return () => observer.disconnect()
  })

  // The newest load started, so an older one failing late doesn't overwrite it.
  let latestLoad = 0

  /** Loads `url` onto the stage, reporting failure in place of the model. */
  async function loadInto(target: ModelStage, url: string, filePath: string): Promise<void> {
    latestLoad += 1
    const thisLoad = latestLoad
    loading = true
    error = null
    try {
      const keepView = loadedPath === filePath
      const loaded = await target.load(url, extensionOf(filePath), keepView)
      if (loaded === null) return
      stats = loaded
      loadedPath = filePath
      loading = false
    } catch (cause) {
      if (thisLoad !== latestLoad) return
      error = (cause as Error).message
      stats = null
      loading = false
    }
  }

  /** The theme's colours for the grid and for models that bring none of their own. */
  function themeColors(): { grid: string; gridCenter: string; surface: string } {
    const style = getComputedStyle(document.documentElement)
    return {
      grid: cssColor(style, '--border', '#333333'),
      gridCenter: cssColor(style, '--text-faint', '#555555'),
      surface: cssColor(style, '--text-muted', '#a1a1aa')
    }
  }

  function cssColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
    const value = style.getPropertyValue(name).trim()
    if (value === '') return fallback
    return value
  }

  function toggleWireframe(): void {
    wireframe = !wireframe
    stage?.setWireframe(wireframe)
  }

  function resetView(): void {
    stage?.resetView()
  }

  /** The toolbar's summary of the loaded model. */
  function summary(loaded: ModelStats): string {
    const counts = `${formatCount(loaded.vertices)} vertices · ${formatCount(loaded.triangles)} triangles`
    if (!loaded.animated) return counts
    return `${counts} · animated`
  }

  /** A count with thousands separators. */
  function formatCount(count: number): string {
    return count.toLocaleString()
  }
</script>

<div class="relative min-h-0 flex-1 overflow-hidden bg-canvas">
  <canvas bind:this={canvasEl} class="block h-full w-full outline-none"></canvas>
  {#if error !== null}
    <div class="absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-dim">
      This model could not be loaded: {error}
    </div>
  {:else if stats !== null && stats.vertices === 0}
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-dim">
      This file has no geometry to show — only animation or scene data.
    </div>
  {:else if loading}
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-dim">
      Loading model…
    </div>
  {/if}
</div>
<MediaToolbar>
  {#snippet info()}
    {#if stats !== null}{summary(stats)}{/if}
  {/snippet}
  {#snippet actions()}
    <MediaToolButton title="Wireframe" active={wireframe} onclick={toggleWireframe}>
      Wireframe
    </MediaToolButton>
    <MediaToolButton title="Reset view" onclick={resetView}>Reset</MediaToolButton>
  {/snippet}
</MediaToolbar>
