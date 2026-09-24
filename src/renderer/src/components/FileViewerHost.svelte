<script lang="ts">
  // A file open in the editor pane through a registered viewer rather than
  // nvim. Hands the viewer a grove-file:// URL for the file, re-issued whenever
  // the file changes on disk so an edited image or re-exported model shows its
  // new bytes, and takes keyboard focus in nvim's place.
  import { store } from '../lib/store.svelte'
  import { worktreeFileUrl } from '../lib/fileUrl'
  import type { FileViewer } from '../lib/fileViewers.svelte'

  let { worktreeId, path, viewer }: { worktreeId: string; path: string; viewer: FileViewer } =
    $props()

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

  const src = $derived.by(() => {
    const worktree = store.worktrees.find((entry) => entry.id === worktreeId)
    if (!worktree) return null
    const base = worktreeFileUrl(worktreeId, worktree.path, path)
    if (base === null) return null
    // Busts the renderer's cache; main ignores the query.
    if (version === 0) return base
    return `${base}?v=${version}`
  })

  /** Moves keyboard focus onto the viewer, the way the editor focuses nvim. */
  export function focus(): void {
    rootEl?.focus({ preventScroll: true })
  }
</script>

<div
  bind:this={rootEl}
  class="flex h-full w-full flex-col bg-surface outline-none"
  tabindex="-1"
  role="region"
  aria-label="{viewer.label} viewer"
>
  {#if src === null}
    <div class="flex h-full items-center justify-center text-xs text-dim">
      This file is outside the worktree and can't be previewed.
    </div>
  {:else}
    <!-- No pending state: a viewer already fetched resolves within a tick,
         and a placeholder would flash on every tab switch. -->
    {#await viewer.load() then { default: Viewer }}
      <Viewer {worktreeId} {path} {src} options={viewer.options} />
    {:catch loadError}
      <div class="flex h-full items-center justify-center text-xs text-dim">
        The {viewer.label} viewer could not be loaded: {loadError.message}
      </div>
    {/await}
  {/if}
</div>
