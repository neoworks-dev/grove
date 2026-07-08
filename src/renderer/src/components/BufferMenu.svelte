<script lang="ts">
  import Icon from '@iconify/svelte'
  import { bufferMenu } from '../lib/buffermenu.svelte'
  import { store } from '../lib/store.svelte'
  import { fileIcon } from '../lib/icons'

  let activeIndex = $state(0)
  let dialogEl = $state<HTMLDivElement>()

  // Buffers = open editor tabs for the current worktree, in tab order.
  const buffers = $derived(
    store.tabs.filter((tab) => tab.worktreeId === store.selectedWorktreeId)
  )
  const selected = $derived(buffers[activeIndex] || null)

  // Start on the active buffer each time the menu opens.
  $effect(() => {
    if (!bufferMenu.open) return
    const current = buffers.findIndex((tab) => tab.path === store.activeTabPath)
    activeIndex = current >= 0 ? current : 0
    queueMicrotask(() => dialogEl?.focus())
  })

  // Keep the selection in range as buffers close.
  $effect(() => {
    if (activeIndex >= buffers.length) activeIndex = Math.max(0, buffers.length - 1)
  })

  function switchTo(path: string): void {
    store.activeTabPath = path
    store.centerView = 'editor'
    bufferMenu.close()
  }

  interface Action {
    key: string
    label: string
    run: (path: string) => void
  }
  const actions: Action[] = [
    { key: 'p', label: 'Pin', run: (path) => store.togglePin(path) },
    { key: 'x', label: 'Close', run: (path) => store.closeTab(path) },
    { key: 'o', label: 'Close others', run: (path) => store.closeOtherTabs(path) },
    { key: 'h', label: 'Close left', run: (path) => store.closeTabsToSide(path, 'left') },
    { key: 'l', label: 'Close right', run: (path) => store.closeTabsToSide(path, 'right') }
  ]

  function runAction(action: Action): void {
    if (!selected) return
    action.run(selected.path)
    // Closing the last buffer leaves nothing to act on.
    if (buffers.length === 0) bufferMenu.close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      bufferMenu.close()
      return
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      activeIndex = Math.min(activeIndex + 1, buffers.length - 1)
      return
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selected) switchTo(selected.path)
      return
    }
    const action = actions.find((candidate) => candidate.key === event.key)
    if (action) {
      event.preventDefault()
      runAction(action)
    }
  }
</script>

{#if bufferMenu.open}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[12vh]"
    role="button"
    tabindex="0"
    onclick={() => bufferMenu.close()}
    onkeydown={(event) => event.key === 'Escape' && bufferMenu.close()}
  >
    <div
      bind:this={dialogEl}
      class="flex max-h-[64vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="border-b border-line px-3 py-2 text-2xs font-medium text-dim">Buffers</div>

      <div class="min-h-0 flex-1 overflow-auto py-1">
        {#each buffers as buffer, index (buffer.path)}
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left {index === activeIndex
              ? 'bg-hover'
              : ''} hover:bg-hover"
            onmousemove={() => (activeIndex = index)}
            onclick={() => switchTo(buffer.path)}
          >
            <Icon icon={fileIcon(buffer.name)} width="16" height="16" class="shrink-0" />
            <span
              class="truncate text-xs {buffer.path === store.activeTabPath
                ? 'text-default'
                : 'text-muted'}">{buffer.name}</span
            >
            {#if buffer.pinned}
              <Icon icon="ph:push-pin-fill" width="12" height="12" class="ml-auto shrink-0 text-amber" />
            {/if}
          </button>
        {/each}
        {#if buffers.length === 0}
          <p class="px-3 py-4 text-xs text-dim">No open buffers.</p>
        {/if}
      </div>

      <div class="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
        {#each actions as action (action.key)}
          <button
            class="rounded-md border border-line px-2 py-1 text-2xs text-muted hover:bg-hover"
            onclick={() => runAction(action)}
          >
            <span class="font-mono text-dim">{action.key}</span>
            {action.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
