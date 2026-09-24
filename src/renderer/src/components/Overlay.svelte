<script lang="ts">
  // The canonical overlay component — renders whatever descriptor is active in
  // the overlay controller: input + streamed list, optional preview column,
  // multi-select marks, and footer action hints.
  import Icon from '@iconify/svelte'
  import { fade, scale } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { overlays } from '../lib/overlays.svelte'
  import { stepFromEvent, stepMatchesSequence } from '../lib/keySequence'
  import { fileIcon } from '../lib/icons'
  import { highlightCode, type HighlightedToken } from '../lib/highlight'
  import { languageOfPath, pathLabelOf } from '../lib/agents/tools'
  import { store } from '../lib/store.svelte'
  import { untrack } from 'svelte'
  import { rememberFocus } from '../lib/focusReturn'

  // 'file:<name>' resolves through the active icon pack (plugins can't call
  // fileIcon themselves).
  function resolveIcon(icon: string): string {
    if (icon.startsWith('file:')) return fileIcon(icon.slice(5))
    return icon
  }

  let inputEl = $state<HTMLInputElement>()
  let listViewport = $state<HTMLDivElement>()
  let previewViewport = $state<HTMLDivElement>()

  const descriptor = $derived(overlays.active)
  const hasPreview = $derived(descriptor?.onPreview !== undefined)

  // Hands focus back to where it was once the overlay closes. Declared before
  // the effect below so it records focus before the input takes it; one
  // overlay replacing another keeps the first one's return point.
  let surfaceEl = $state<HTMLDivElement>()
  let returnFocus: ((surface: HTMLElement | undefined) => void) | null = null
  $effect(() => {
    const open = descriptor !== null
    if (open && returnFocus === null) {
      returnFocus = rememberFocus()
      return
    }
    if (!open && returnFocus !== null) {
      returnFocus(untrack(() => surfaceEl))
      returnFocus = null
    }
  })

  $effect(() => {
    if (!descriptor) return
    queueMicrotask(() => {
      inputEl?.focus()
      // Prefilled query (e.g. rename): select it so typing replaces the name.
      if (descriptor.initialQuery) inputEl?.select()
    })
  })

  // Scrolling to the end of the list draws the next page of what has already
  // arrived. The margin is a screenful, so the rows are there before the scroll
  // reaches them.
  const REVEAL_MARGIN_PX = 400

  $effect(() => {
    const viewport = listViewport
    if (!viewport) return
    const onScroll = (): void => {
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (remaining <= REVEAL_MARGIN_PX) overlays.revealMore()
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  })

  // Keep the active result visible as arrow keys move the selection; the list
  // viewport is FloatingScrollbar's own scroll element.
  $effect(() => {
    const index = overlays.activeIndex
    void index
    if (!listViewport) return
    const active = listViewport.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  })

  // The excerpt's lines, coloured. Empty until shiki has the grammar, so the
  // code is readable from the first frame and gains colour a tick later.
  let highlighted = $state<HighlightedToken[][]>([])

  $effect(() => {
    const preview = overlays.preview
    if (preview?.kind !== 'excerpt') {
      highlighted = []
      return
    }
    const code = preview.lines.map((line) => line.text).join('\n')
    const language = languageOfPath(preview.file)
    const scheme = store.activeTheme.scheme
    let current = true
    void highlightCode(code, language, scheme).then((lines) => {
      if (current) highlighted = lines ?? []
    })
    return () => {
      current = false
    }
  })

  // An excerpt is longer than the pane on purpose, so the code around a match
  // fills the space rather than floating in the middle of it. Centring the line
  // the match is on is what makes the extra lines read as context.
  $effect(() => {
    const preview = overlays.preview
    if (preview?.kind !== 'excerpt' || !previewViewport) return
    queueMicrotask(() => {
      const line = previewViewport?.querySelector<HTMLElement>('[data-highlight="true"]')
      line?.scrollIntoView({ block: 'center' })
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
    const pressed = stepFromEvent(event)
    const action = descriptor.actions.find((candidate) =>
      stepMatchesSequence(candidate.key, pressed)
    )
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    overlays.runAction(action)
  }
</script>

{#if descriptor}
  <div
    bind:this={surfaceEl}
    class="fixed inset-0 z-modal flex items-start justify-center bg-black/50 pt-[12vh]"
    role="button"
    tabindex="0"
    transition:fade={{ duration: 120 }}
    onclick={() => overlays.cancel()}
    onkeydown={(event) => event.key === 'Escape' && overlays.cancel()}
  >
    <div
      class="flex max-h-[64vh] {hasPreview
        ? 'w-[860px]'
        : 'w-[560px]'} max-w-[92vw] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
      role="dialog"
      tabindex="-1"
      transition:scale={{ duration: 140, start: 0.97, opacity: 0, easing: cubicOut }}
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
        <FloatingScrollbar
          class="min-h-0 {hasPreview ? 'w-1/2 border-r border-line' : 'w-full'} py-1"
          bind:viewport={listViewport}
        >
          <!-- Single content wrapper so the scrollbar's ResizeObserver watches
               one child, not one per result row. -->
          <div>
          {#each overlays.items as item, index (item.id)}
            {@const active = index === overlays.activeIndex}
            {@const ItemRow = descriptor.itemComponent}
            <button
              data-active={active}
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left {active
                ? 'bg-hover'
                : ''} hover:bg-hover"
              onmousemove={() => index !== overlays.activeIndex && overlays.focusIndex(index)}
              onclick={() => {
                overlays.focusIndex(index)
                overlays.accept()
              }}
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
                <!-- A path leads with its file name: truncating a label cuts the
                     end off, and the end of a path is the part being looked for. -->
                {@const path = pathLabelOf(item.label, '')}
                {#if path && path.directory}
                  <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span class="shrink-0 text-xs {active ? 'text-default' : 'text-muted'}">
                      {path.name}
                    </span>
                    {#if item.description}
                      <span class="shrink-0 text-2xs text-dim">{item.description}</span>
                    {/if}
                    <span class="truncate text-2xs text-faint">{path.directory}</span>
                  </span>
                {:else}
                  <span
                    class="min-w-0 flex-1 truncate text-xs {active ? 'text-default' : 'text-muted'}"
                  >
                    {item.label}
                    {#if item.description}
                      <span class="text-dim">{item.description}</span>
                    {/if}
                  </span>
                {/if}
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
          <!-- Scrolling draws more of what arrived; past what is held, there is
               nothing to scroll to and the search wants narrowing instead. -->
          {#if overlays.capped && !overlays.hasMore}
            <p class="px-3 py-1.5 text-2xs text-dim">
              More was found than is kept — narrow the search for the rest.
            </p>
          {/if}
          </div>
        </FloatingScrollbar>

        {#if hasPreview}
          <FloatingScrollbar class="min-h-0 w-1/2" bind:viewport={previewViewport}>
            <div>
            {#if overlays.preview?.kind === 'excerpt'}
              <!-- The excerpt scrolls; which file it is from does not. -->
              <div
                class="sticky top-0 z-10 truncate border-b border-line bg-surface px-3 py-1.5 font-mono text-2xs text-dim"
              >
                {overlays.preview.file}
              </div>
              <pre class="p-0 font-mono text-2xs leading-relaxed">{#each overlays.preview.lines as line, index (line.n)}<span
                    data-highlight={line.n === overlays.preview.highlightLine}
                    class="block border-l-2 pl-1 pr-3 {line.n === overlays.preview.highlightLine
                      ? 'border-amber bg-amber-soft'
                      : 'border-transparent'}"><span
                      class="mr-3 inline-block w-8 text-right {line.n ===
                      overlays.preview.highlightLine
                        ? 'text-amber'
                        : 'text-faint'}">{line.n}</span>{#if highlighted[index]}{#each highlighted[index] as token, tokenIndex (tokenIndex)}<span
                        style:color={token.color}>{token.text}</span>{/each}{:else}<span class="text-muted"
                      >{line.text}</span>{/if}</span>{/each}</pre>
            {:else if overlays.preview?.kind === 'text'}
              <pre class="whitespace-pre-wrap p-3 font-mono text-2xs text-muted">{overlays.preview.text}</pre>
            {:else if overlays.preview?.kind === 'component'}
              {@const PreviewComponent = overlays.preview.component}
              <PreviewComponent {...overlays.preview.props ?? {}} />
            {/if}
            </div>
          </FloatingScrollbar>
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
