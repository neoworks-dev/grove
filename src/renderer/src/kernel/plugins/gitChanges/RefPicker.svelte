<script lang="ts" module>
  export interface RefOption {
    value: string
    label: string
  }
</script>

<script lang="ts">
  // A compact ref picker for the compare section: an icon saying which side it
  // is, the picked ref, and a popover listing every ref with a search box. The
  // design system's Select is sized for forms, not for 22px sidebar rows.
  import type { Component } from 'svelte'
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon'
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'

  let {
    icon: Icon,
    label,
    value,
    options,
    placeholder = 'Pick a ref',
    onChange
  }: {
    icon: Component
    /** Which side this is, for the tooltip and screen readers. */
    label: string
    value: string | null
    options: RefOption[]
    placeholder?: string
    onChange: (value: string) => void
  } = $props()

  // The popover never gets narrower than this, however narrow the trigger.
  const MIN_POPOVER_WIDTH = 200

  let open = $state(false)
  let query = $state('')
  let activeIndex = $state(0)
  let trigger = $state<HTMLButtonElement>()
  let popover = $state<HTMLDivElement>()
  let searchInput = $state<HTMLInputElement>()
  let position = $state({ top: 0, left: 0, width: MIN_POPOVER_WIDTH })

  const picked = $derived(options.find((option) => option.value === value))
  const visible = $derived(
    options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
  )

  /** Opens the popover under the trigger, or closes it. */
  function toggle(): void {
    if (open) {
      open = false
      return
    }
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.max(rect.width, MIN_POPOVER_WIDTH)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    position = { top: rect.bottom + 4, left, width }
    query = ''
    activeIndex = Math.max(0, visible.findIndex((option) => option.value === value))
    open = true
  }

  /** Picks an option and closes. */
  function choose(option: RefOption): void {
    open = false
    onChange(option.value)
  }

  /** Arrows move through the list, Enter picks, Escape closes. */
  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      open = false
      trigger?.focus()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = visible[activeIndex]
      if (option) choose(option)
      return
    }
    let step = 0
    if (event.key === 'ArrowDown') step = 1
    if (event.key === 'ArrowUp') step = -1
    if (step === 0) return
    event.preventDefault()
    activeIndex = Math.min(Math.max(0, activeIndex + step), visible.length - 1)
  }

  /** Closes the popover when a press lands outside it and its trigger. */
  function onWindowPointerDown(event: PointerEvent): void {
    if (!open || !(event.target instanceof Node)) return
    if (popover?.contains(event.target) || trigger?.contains(event.target)) return
    open = false
  }

  $effect(() => {
    if (open) searchInput?.focus()
  })

  // A new query starts from the top of what it matches.
  $effect(() => {
    void query
    activeIndex = 0
  })
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<button
  bind:this={trigger}
  type="button"
  class="flex h-6 w-full min-w-0 items-center gap-1 rounded-md border border-line bg-input px-1.5 text-xs hover:border-line-strong"
  class:border-line-strong={open}
  title="{label}: {picked ? picked.label : placeholder}"
  aria-label={label}
  aria-haspopup="listbox"
  aria-expanded={open}
  onclick={toggle}
>
  <Icon size={12} class="shrink-0 text-dim" />
  <span class="min-w-0 flex-1 truncate text-left" class:text-default={picked} class:text-faint={!picked}>
    {#if picked}{picked.label}{:else}{placeholder}{/if}
  </span>
  <CaretDownIcon size={10} class="shrink-0 text-dim" />
</button>

{#if open}
  <div
    bind:this={popover}
    class="fixed z-modal flex flex-col overflow-hidden rounded-md border border-line bg-elevated shadow-overlay"
    style:top="{position.top}px"
    style:left="{position.left}px"
    style:width="{position.width}px"
  >
    <input
      bind:this={searchInput}
      bind:value={query}
      class="border-b border-line bg-transparent px-2 py-1 text-xs text-default outline-none placeholder:text-dim"
      placeholder="Search refs"
      spellcheck="false"
      aria-label="Search refs"
      onkeydown={onSearchKeydown}
    />
    <FloatingScrollbar class="max-h-64">
      <div class="py-1" role="listbox" aria-label={label}>
        {#each visible as option, index (option.value)}
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs text-muted hover:bg-hover"
            class:bg-hover={index === activeIndex}
            role="option"
            aria-selected={option.value === value}
            onclick={() => choose(option)}
            onpointerenter={() => (activeIndex = index)}
          >
            <span class="grid w-3 shrink-0 place-items-center">
              {#if option.value === value}<CheckIcon size={10} />{/if}
            </span>
            <span class="truncate">{option.label}</span>
          </button>
        {:else}
          <p class="px-2 py-1 text-2xs text-dim">No refs match.</p>
        {/each}
      </div>
    </FloatingScrollbar>
  </div>
{/if}
