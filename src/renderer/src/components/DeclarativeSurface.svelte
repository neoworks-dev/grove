<script lang="ts">
  // Generic renderer for plugin pane types: asks the plugin worker for a
  // SurfaceNode descriptor tree and renders it with canonical widgets. The
  // plugin re-renders by calling grove.panes.update(id).
  import { pluginHost } from '../plugins/host.svelte'

  let { paneTypeId }: { paneTypeId: string } = $props()

  interface SurfaceNode {
    type: 'stack' | 'text' | 'list' | 'button'
    direction?: 'row' | 'column'
    children?: SurfaceNode[]
    text?: string
    style?: 'default' | 'muted' | 'mono'
    items?: { id: string; label: string; description?: string }[]
    onSelect?: string
    label?: string
    command?: string
  }

  let surface = $state<SurfaceNode | null>(null)
  let error = $state<string | null>(null)

  // Re-render whenever the plugin bumps the pane's version.
  $effect(() => {
    void pluginHost.paneVersion(paneTypeId)
    void pluginHost
      .renderPane(paneTypeId)
      .then((node) => {
        surface = node as SurfaceNode | null
        error = null
      })
      .catch((cause: Error) => {
        error = cause.message
      })
  })

  function runCommand(commandId: string | undefined, argument?: string): void {
    if (!commandId) return
    void pluginHost.executeCommandById(commandId, argument === undefined ? [] : [argument])
  }

  const textClass: Record<string, string> = {
    default: 'text-default text-xs',
    muted: 'text-muted text-xs',
    mono: 'font-mono text-2xs text-muted'
  }
</script>

{#snippet surfaceNode(node: SurfaceNode)}
  {#if node.type === 'stack'}
    <div class="flex min-h-0 min-w-0 gap-2 {node.direction === 'row' ? 'flex-row' : 'flex-col'}">
      {#each node.children ?? [] as child, index (index)}
        {@render surfaceNode(child)}
      {/each}
    </div>
  {:else if node.type === 'text'}
    <p class={textClass[node.style ?? 'default']}>{node.text}</p>
  {:else if node.type === 'list'}
    <div class="flex flex-col">
      {#each node.items ?? [] as item (item.id)}
        <button
          class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-hover hover:text-default"
          onclick={() => runCommand(node.onSelect, item.id)}
        >
          <span class="truncate">{item.label}</span>
          {#if item.description}
            <span class="ml-auto truncate text-2xs text-dim">{item.description}</span>
          {/if}
        </button>
      {/each}
    </div>
  {:else if node.type === 'button'}
    <button
      class="self-start rounded-md border border-line bg-surface px-2 py-1 text-xs hover:bg-hover"
      onclick={() => runCommand(node.command)}
    >
      {node.label}
    </button>
  {/if}
{/snippet}

<div class="min-h-0 flex-1 overflow-auto p-3">
  {#if error}
    <p class="text-xs text-red">{error}</p>
  {:else if surface}
    {@render surfaceNode(surface)}
  {:else}
    <p class="text-xs text-dim">Loading…</p>
  {/if}
</div>
