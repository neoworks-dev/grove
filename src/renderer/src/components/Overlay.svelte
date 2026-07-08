<script lang="ts">
  // The canonical overlay component — renders whatever descriptor is active in
  // the overlay controller: input + streamed list, optional preview column,
  // multi-select marks, and footer action hints.
  import Icon from '@iconify/svelte'
  import { overlays } from '../lib/overlays.svelte'
  import { stepFromEvent, formatStep } from '../lib/keySequence'
  import { fileIcon } from '../lib/icons'

  // 'file:<name>' resolves through the active icon pack (plugins can't call
  // fileIcon themselves).
  function resolveIcon(icon: string): string {
    if (icon.startsWith('file:')) return fileIcon(icon.slice(5))
    return icon
  }

  let inputEl = $state<HTMLInputElement>()

  const descriptor = $derived(overlays.active)
  const hasPreview = $derived(descriptor?.onPreview !== undefined)

  $effect(() => {
    if (!descriptor) return
    queueMicrotask(() => {
      inputEl?.focus()
      // Prefilled query (e.g. rename): select it so typing replaces the name.
      if (descriptor.initialQuery) inputEl?.select()
    })
  })

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      overlays.cancel()
      return
    }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
      event.preventDefault()
      overlays.move(1)
      return
    }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
      event.preventDefault()
      overlays.move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      overlays.accept()
      return
    }
    if (event.key === 'Tab' && descriptor?.multiSelect) {
      event.preventDefault()
      overlays.toggleSelected()
      return
    }
    runMatchingAction(event)
  }

  function runMatchingAction(event: KeyboardEvent): void {
    if (!descriptor?.actions) return
    const pressed = formatStep(stepFromEvent(event))
    const action = descriptor.actions.find((candidate) => candidate.key === pressed)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    overlays.runAction(action)
  }
</script>

{#if descriptor}
  <div
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[12vh]"
    role="button"
    tabindex="0"
    onclick={() => overlays.cancel()}
    onkeydown={(event) => event.key === 'Escape' && overlays.cancel()}
  >
    <div
      class="flex max-h-[64vh] {hasPreview
        ? 'w-[860px]'
        : 'w-[560px]'} max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={onKeyDown}
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <input
          bind:this={inputEl}
          value={overlays.query}
          oninput={(event) => overlays.setQuery(event.currentTarget.value)}
          class="w-full bg-transparent py-3 text-sm outline-none"
          placeholder={descriptor.placeholder}
        />
      </div>

      <div class="flex min-h-0 flex-1">
        <div class="min-h-0 {hasPreview ? 'w-1/2 border-r border-line' : 'w-full'} overflow-auto py-1">
          {#each overlays.items as item, index (item.id)}
            {@const active = index === overlays.activeIndex}
            {@const ItemRow = descriptor.itemComponent}
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left {active
                ? 'bg-hover'
                : ''} hover:bg-hover"
              onmousemove={() => index !== overlays.activeIndex && overlays.focusIndex(index)}
              onclick={() => overlays.accept()}
            >
              {#if descriptor.multiSelect}
                <Icon
                  icon={overlays.selectedIds.has(item.id) ? 'ph:check-square-fill' : 'ph:square'}
                  width="14"
                  class="shrink-0 {overlays.selectedIds.has(item.id) ? 'text-accent' : 'text-dim'}"
                />
              {/if}
              {#if ItemRow}
                <ItemRow {item} {active} />
              {:else}
                {#if item.icon}
                  <Icon icon={resolveIcon(item.icon)} width="16" height="16" class="shrink-0" />
                {/if}
                <span class="min-w-0 flex-1 truncate text-xs {active ? 'text-default' : 'text-muted'}">
                  {item.label}
                  {#if item.description}
                    <span class="text-dim">{item.description}</span>
                  {/if}
                </span>
                {#if item.detail}
                  <span class="max-w-[45%] shrink-0 truncate text-2xs text-dim">{item.detail}</span>
                {/if}
                {#if item.trailingIcon}
                  <Icon icon={item.trailingIcon} width="12" class="shrink-0 text-amber" />
                {/if}
              {/if}
            </button>
          {/each}
          {#if overlays.items.length === 0}
            <p class="px-3 py-4 text-xs text-dim">No results.</p>
          {/if}
        </div>

        {#if hasPreview}
          <div class="min-h-0 w-1/2 overflow-auto">
            {#if overlays.preview?.kind === 'excerpt'}
              <div class="border-b border-line px-3 py-1.5 font-mono text-2xs text-dim">
                {overlays.preview.file}
              </div>
              <pre class="p-0 font-mono text-2xs leading-relaxed">{#each overlays.preview.lines as line (line.n)}<span
                    class="block px-3 {line.n === overlays.preview.highlightLine
                      ? 'bg-hover text-default'
                      : 'text-muted'}"><span class="mr-3 inline-block w-8 text-right text-faint">{line.n}</span>{line.text}</span>{/each}</pre>
            {:else if overlays.preview?.kind === 'text'}
              <pre class="whitespace-pre-wrap p-3 font-mono text-2xs text-muted">{overlays.preview.text}</pre>
            {:else if overlays.preview?.kind === 'component'}
              {@const PreviewComponent = overlays.preview.component}
              <PreviewComponent {...overlays.preview.props ?? {}} />
            {/if}
          </div>
        {/if}
      </div>

      {#if descriptor.actions && descriptor.actions.length > 0}
        <div class="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
          {#each descriptor.actions as action (action.key)}
            <button
              class="rounded-md border border-line px-2 py-1 text-2xs text-muted hover:bg-hover"
              onclick={() => overlays.runAction(action)}
            >
              <span class="font-mono text-dim">{action.key}</span>
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
