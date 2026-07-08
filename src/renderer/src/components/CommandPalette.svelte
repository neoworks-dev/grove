<script lang="ts">
  import { commands } from '../lib/commands.svelte'
  import Icon from '@iconify/svelte'

  let query = $state('')
  let activeIndex = $state(0)
  let inputEl = $state<HTMLInputElement>()

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const list = commands.commands
    if (!q) return list
    return list.filter((command) => {
      const haystack = `${command.title} ${command.group || ''} ${command.keywords || ''}`.toLowerCase()
      return q.split(/\s+/).every((term) => haystack.includes(term))
    })
  })

  // Reset selection + focus when opened.
  $effect(() => {
    if (commands.paletteOpen) {
      query = ''
      activeIndex = 0
      queueMicrotask(() => inputEl?.focus())
    }
  })

  $effect(() => {
    filtered.length
    if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1)
  })

  async function run(index: number): Promise<void> {
    const command = filtered[index]
    if (!command) return
    commands.close()
    await command.run()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      commands.close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      activeIndex = Math.max(activeIndex - 1, 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void run(activeIndex)
    }
  }
</script>

{#if commands.paletteOpen}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[12vh]"
    role="button"
    tabindex="0"
    onclick={() => commands.close()}
    onkeydown={(event) => event.key === 'Escape' && commands.close()}
  >
    <div
      class="w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="0"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <Icon icon="vscode-icons:default-file" class="opacity-0" width="16" />
        <input
          bind:this={inputEl}
          bind:value={query}
          class="w-full bg-transparent py-3 text-sm outline-none"
          placeholder="Type a command…"
        />
      </div>
      <div class="max-h-[50vh] overflow-auto py-1">
        {#each filtered as command, index (command.id)}
          <button
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm {index ===
            activeIndex
              ? 'bg-hover text-default'
              : 'text-muted'}"
            onmousemove={() => (activeIndex = index)}
            onclick={() => run(index)}
          >
            <span class="flex-1 truncate">{command.title}</span>
            {#if command.group}
              <span class="text-2xs text-dim">{command.group}</span>
            {/if}
          </button>
        {/each}
        {#if filtered.length === 0}
          <p class="px-3 py-4 text-xs text-dim">No matching commands.</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
