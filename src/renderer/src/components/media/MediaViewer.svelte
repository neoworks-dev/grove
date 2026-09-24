<script lang="ts">
  // A media file open in the editor pane: drawn over nvim in place of the
  // buffer it would otherwise be, under the same tab strip. Picks the viewer by
  // extension and hands it a grove-file:// URL, re-issued whenever the file
  // changes on disk so an edited image or re-exported model shows its new bytes.
  import { store } from '../../lib/store.svelte'
  import { mediaKind, mediaUrl } from '../../lib/media'
  import ImageViewer from './ImageViewer.svelte'
  import PlayerViewer from './PlayerViewer.svelte'

  // pdf.js and three.js are most of this feature's weight; they load with the
  // first PDF or model opened, not with the app.
  /** The PDF viewer's module, fetched on first use. */
  function loadPdfViewer(): Promise<typeof import('./PdfViewer.svelte')> {
    return import('./PdfViewer.svelte')
  }

  /** The model viewer's module, fetched on first use. */
  function loadModelViewer(): Promise<typeof import('./ModelViewer.svelte')> {
    return import('./ModelViewer.svelte')
  }

  let { worktreeId, path }: { worktreeId: string; path: string } = $props()

  let rootEl = $state<HTMLDivElement>()
  // Bumped when this file changes on disk. Only this file: a model viewer
  // reloading on every write in the worktree would lose its camera to each one.
  let version = $state(0)

  $effect(() => {
    const watchedPath = path
    return window.workbench.on('event:fs-change', (payload) => {
      const event = payload as { path: string; type: string }
      if (event.path !== watchedPath) return
      if (event.type !== 'change' && event.type !== 'add') return
      version += 1
    })
  })

  const kind = $derived(mediaKind(path))

  const url = $derived.by(() => {
    const worktree = store.worktrees.find((entry) => entry.id === worktreeId)
    if (!worktree) return null
    const base = mediaUrl(worktreeId, worktree.path, path)
    if (base === null) return null
    // Busts the renderer's cache; main ignores the query.
    if (version === 0) return base
    return `${base}?v=${version}`
  })

  /** Moves keyboard focus onto the viewer, so keys stop reaching the nvim beneath. */
  export function focus(): void {
    rootEl?.focus({ preventScroll: true })
  }
</script>

<div
  bind:this={rootEl}
  class="absolute inset-0 z-30 flex flex-col bg-surface outline-none"
  tabindex="-1"
  role="region"
  aria-label="Media viewer"
>
  {#if url === null}
    <div class="flex h-full items-center justify-center text-xs text-dim">
      This file is outside the worktree and can't be previewed.
    </div>
  {:else if kind === 'image'}
    <ImageViewer src={url} />
  {:else if kind === 'video' || kind === 'audio'}
    <PlayerViewer src={url} {kind} name={path.split('/').pop() ?? path} />
  {:else if kind === 'pdf'}
    {#await loadPdfViewer() then { default: PdfViewer }}
      <PdfViewer src={url} />
    {/await}
  {:else if kind === 'model'}
    {#await loadModelViewer() then { default: ModelViewer }}
      <ModelViewer src={url} {path} />
    {/await}
  {/if}
</div>
