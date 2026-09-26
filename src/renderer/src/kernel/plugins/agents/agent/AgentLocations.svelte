<script lang="ts">
  // Places in the code an agent pointed at, as a card in the conversation.
  //
  // Nothing opens by itself: an answer naming four places used to open four
  // files and mark all of them. Here each place is a row, and picking one opens
  // that file with its lines marked and the agent's notes written above them —
  // replacing whatever the last pick marked, so one place is in view at a time.
  //
  // The code moves on after the agent answers. Each place is looked up again as
  // the card comes into view and when it is picked, so a row follows its code to
  // new lines or a new name, and says so when the code it meant is gone.
  import Icon from '@iconify/svelte'
  import CrosshairIcon from 'phosphor-svelte/lib/CrosshairIcon'
  import { fileIcon } from '../../../../lib/icons'
  import { resolveLocations } from '../../../../lib/agents/locations'
  import type { CodeLocation, LocationState, ResolvedLocation } from '../../../../lib/agents/types'

  let {
    title,
    locations,
    root = '',
    onOpen
  }: {
    title?: string
    locations: CodeLocation[]
    /** The worktree the session runs in; paths show relative to it. */
    root?: string
    onOpen?: (location: CodeLocation, state: LocationState) => void
  } = $props()

  // A card scrolled past and back is not looked up again sooner than this.
  const RECHECK_AFTER_MS = 3000

  // The row opened last, so the card shows which place is on screen.
  let openedIndex = $state<number | null>(null)
  // Where each place is now, once looked up; until then, where the agent said.
  let resolved = $state<ResolvedLocation[] | null>(null)
  let checkedAt = 0
  let lookup = 0

  /** A row's place as last looked up. */
  function placeOf(index: number): ResolvedLocation {
    const found = resolved?.[index]
    if (found) return found
    return { location: locations[index], state: 'current' }
  }

  /** Look every place up again, keeping only the newest answer. */
  async function recheck(): Promise<void> {
    checkedAt = Date.now()
    lookup += 1
    const mine = lookup
    const found = await resolveLocations(root, locations)
    if (mine !== lookup) return
    resolved = found
  }

  /** Look the places up again unless that was done a moment ago. */
  function recheckIfStale(): void {
    if (Date.now() - checkedAt < RECHECK_AFTER_MS) return
    void recheck()
  }

  /**
   * Looks the places up whenever the card scrolls into view, and when the
   * pointer comes over it: a card that stayed on screen while the code was
   * edited is brought up to date before a row is picked.
   */
  function whenVisible(element: HTMLElement): () => void {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) recheckIfStale()
    })
    observer.observe(element)
    element.addEventListener('pointerenter', recheckIfStale)
    return () => {
      observer.disconnect()
      element.removeEventListener('pointerenter', recheckIfStale)
    }
  }

  /** A path as the user reads it: relative to the worktree when it is inside it. */
  function shownPath(path: string): string {
    const prefix = `${root}/`
    if (root && path.startsWith(prefix)) return path.slice(prefix.length)
    return path
  }

  /** The line range after the path, or nothing for a whole file. */
  function rangeOf(location: CodeLocation): string {
    if (location.startLine === undefined) return ''
    if (location.endLine === undefined || location.endLine === location.startLine) {
      return `:${location.startLine}`
    }
    return `:${location.startLine}-${location.endLine}`
  }

  /** The row's tooltip: what opens, and where it was when it has moved. */
  function tooltipOf(index: number): string {
    const place = placeOf(index)
    const target = `${shownPath(place.location.path)}${rangeOf(place.location)}`
    if (place.state === 'removed') return `${shownPath(locations[index].path)} has been removed`
    if (place.state === 'changed') return `Open ${target} — the code there has changed since`
    if (place.state === 'moved') {
      const was = `${shownPath(locations[index].path)}${rangeOf(locations[index])}`
      return `Open ${target} — moved from ${was}`
    }
    return `Open ${target}`
  }

  /** Look one place up and open it where it is now. */
  async function open(index: number): Promise<void> {
    openedIndex = index
    const [place] = await resolveLocations(root, [locations[index]])
    if (resolved) resolved[index] = place
    onOpen?.(place.location, place.state)
  }

  /** How many places the card holds, in words. */
  function countLabel(count: number): string {
    if (count === 1) return '1 location'
    return `${count} locations`
  }

  /** How many lines of a place are annotated, in words. */
  function noteCountLabel(count: number): string {
    if (count === 1) return '1 note'
    return `${count} notes`
  }
</script>

<div
  class="mb-3 overflow-hidden rounded-md border border-line bg-elevated"
  data-testid="agent-locations"
  {@attach whenVisible}
>
  <div class="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-2xs">
    <span class="text-violet"><CrosshairIcon size={12} /></span>
    <span class="min-w-0 flex-1 truncate font-medium text-default">
      {title ?? countLabel(locations.length)}
    </span>
    {#if title}
      <span class="shrink-0 text-dim">{countLabel(locations.length)}</span>
    {/if}
  </div>
  <ul>
    {#each locations as location, index (index)}
      {@const place = placeOf(index)}
      <li>
        <button
          class="flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-1.5 text-left transition-colors duration-100 enabled:hover:bg-hover disabled:cursor-default"
          class:border-l-violet={openedIndex === index}
          class:bg-hover={openedIndex === index}
          class:border-l-transparent={openedIndex !== index}
          title={tooltipOf(index)}
          disabled={place.state === 'removed'}
          onclick={() => open(index)}
        >
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <Icon icon={fileIcon(location.path)} width="12" height="12" class="shrink-0" />
            <span
              class="min-w-0 truncate"
              class:text-default={place.state !== 'removed'}
              class:text-dim={place.state === 'removed'}
              class:line-through={place.state === 'removed'}
            >
              {shownPath(place.location.path)}
            </span>
            <span class="shrink-0 text-dim">{rangeOf(place.location)}</span>
            {#if place.state === 'changed'}
              <span class="ml-auto shrink-0 font-sans text-amber">changed since</span>
            {:else if place.state === 'removed'}
              <span class="ml-auto shrink-0 font-sans text-dim">file removed</span>
            {:else if location.annotations && location.annotations.length > 0}
              <span class="ml-auto shrink-0 text-dim" title="Annotated lines">
                {noteCountLabel(location.annotations.length)}
              </span>
            {/if}
          </span>
          {#if location.note}
            <span class="pl-[18px] text-2xs text-muted">{location.note}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
</div>
