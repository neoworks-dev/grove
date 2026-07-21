<script lang="ts">
  // The bottom panel: a tabbed host that combines the integrated terminal, the
  // diagnostics (Problems) view, and any plugin-contributed panel views. Each
  // tab renders an existing pane type as its body. Visited tabs stay mounted
  // (hidden when inactive) so a terminal's pty and scrollback survive switching.
  import { panes } from '../lib/panes.svelte'
  import { panels } from '../lib/panels.svelte'
  import { layout } from '../lib/layout.svelte'
  import { keymap } from '../lib/keymap.svelte'

  let {
    leafId,
    state: initialState,
    updateState
  }: {
    leafId: string
    state: Record<string, unknown>
    updateState: (patch: Record<string, unknown>) => void
  } = $props()

  const views = $derived(panels.sorted)

  let activeId = $state<string>((initialState.activeTab as string) ?? '')
  let visited = $state<Set<string>>(new Set())

  // Exported instance of each mounted tab body (only some expose focus()).
  const bodies: Record<string, { focus?: () => void }> = {}

  // Clamp the active tab to a view that still exists, defaulting to the first.
  const activeView = $derived(
    views.find((view) => view.id === activeId) ?? views[0]
  )

  function noop(): void {}

  function selectTab(id: string): void {
    activeId = id
    visited.add(id)
    visited = new Set(visited)
    updateState({ activeTab: id })
  }

  function closePanel(): void {
    layout.closeLeaf(leafId)
  }

  // Keep the active tab and its mounted set in sync with the resolved view (e.g.
  // when the initial/persisted tab is gone, or a plugin registers late).
  $effect(() => {
    const view = activeView
    if (!view) return
    if (activeId !== view.id) activeId = view.id
    if (!visited.has(view.id)) {
      visited.add(view.id)
      visited = new Set(visited)
    }
  })

  // A terminal tab needs the pane in 'terminal' mode with its xterm focused so
  // keystrokes reach the shell; every other tab drops back to 'normal'.
  $effect(() => {
    const view = activeView
    if (!view) return
    if (view.paneTypeId === 'terminal') {
      requestAnimationFrame(() => bodies[view.id]?.focus?.())
    } else {
      keymap.setPaneMode(leafId, 'normal')
    }
  })
</script>

<div class="flex h-full w-full flex-col bg-canvas">
  <!-- Tab strip -->
  <div class="flex h-8 shrink-0 items-center gap-1 border-b border-line px-1">
    {#each views as view (view.id)}
      <button
        class="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition {view.id ===
        activeView?.id
          ? 'bg-hover text-default'
          : 'text-dim hover:text-default'}"
        onclick={() => selectTab(view.id)}
      >
        {#if view.icon}
          {@const TabIcon = view.icon}
          <TabIcon size={14} />
        {/if}
        <span>{view.title}</span>
      </button>
    {/each}
    <button
      class="ml-auto flex h-6 w-6 items-center justify-center rounded text-dim transition hover:bg-hover hover:text-default"
      title="Close panel"
      onclick={closePanel}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  </div>

  <!-- Tab bodies: every visited view stays mounted; only the active shows. -->
  <div class="relative min-h-0 flex-1">
    {#each views as view (view.id)}
      {#if visited.has(view.id)}
        {@const type = panes.get(view.paneTypeId)}
        <div class="absolute inset-0 {view.id === activeView?.id ? '' : 'hidden'}">
          {#if type}
            {@const Body = type.component}
            <Body
              bind:this={bodies[view.id]}
              {leafId}
              paneTypeId={view.paneTypeId}
              state={{}}
              updateState={noop}
            />
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>
