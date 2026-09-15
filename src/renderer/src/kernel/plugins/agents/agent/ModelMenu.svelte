<script lang="ts">
  // The model picker: one line per model.
  //
  // Models come first because that is what a person means — "Fable 5.1" — while
  // the route (Anthropic, Bedrock, Vertex, a coding-plan endpoint) is which
  // seller serves it, under an id only that seller uses. Picking a model takes
  // its best route; the others sit behind a per-model fold that prices each
  // one, since the same weights cost different money from different sellers.
  //
  // What separates the list from the fold is whose account pays. Everything on
  // the sign-in grove already has is shown, whether or not the harness listed
  // it: the harness lists a handful of aliases, the same endpoint serves the
  // rest of the plan, and both run. Models that would be billed to somebody
  // else's account sit behind a fold that any search opens.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import {
    matchesQuery,
    preferredRoute,
    routeDetail,
    routeNeedsKey,
    routeUsesOwnSignIn,
    sortedRoutes
  } from '../../../../lib/agents/modelSelection'
  import type { ModelEntry, ModelRoute } from '../../../../lib/agents/types'

  let {
    models,
    provider,
    model,
    switchCostWarning,
    onPick,
    onRequestKey,
    onAddEndpoint
  }: {
    models: ModelEntry[]
    /** The provider and id of the route the session is on. */
    provider: string
    model: string
    /** What a switch costs, when there is a conversation to re-read. */
    switchCostWarning: string
    onPick: (provider: string, model: string) => void
    /** Ask for the key a route needs before it can be taken. */
    onRequestKey: (request: { provider: string; variables: string[] }) => void
    /** Open the editor for an endpoint of the user's own. */
    onAddEndpoint: () => void
  } = $props()

  let query = $state('')
  let showAll = $state(false)

  /** The menu itself, which the endpoint flyout is positioned against. */
  let root = $state<HTMLDivElement | null>(null)

  /** The model whose endpoints are showing, and where beside the menu. */
  let flyout = $state<{ entry: ModelEntry; top: number; onLeft: boolean } | null>(null)

  /** Matches `max-h-60` on the flyout; the anchor is clamped so it fits. */
  const FLYOUT_MAX_HEIGHT = 240

  /** Matches `w-72` plus its margin, for deciding which side it opens on. */
  const FLYOUT_WIDTH = 292

  const matching = $derived(models.filter((entry) => matchesQuery(entry, query)))

  /** Reachable on the sign-in grove already has: shown, harness-listed first. */
  const account = $derived(matching.filter((entry) => entry.routes.some(routeUsesOwnSignIn)))

  /** Models that would be billed to another account, behind the fold. */
  const rest = $derived(matching.filter((entry) => !entry.routes.some(routeUsesOwnSignIn)))

  // A search is a request to look past the account's own models.
  const restOpen = $derived(showAll || query.trim().length > 0)

  /** What was typed, when it names no model grove knows — run it anyway. */
  const typedId = $derived.by(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return ''
    const known = models.some((entry) => entry.routes.some((route) => route.id === trimmed))
    if (known) return ''
    return trimmed
  })

  function isActive(route: ModelRoute): boolean {
    return route.provider === provider && route.id === model
  }

  function entryIsActive(entry: ModelEntry): boolean {
    return entry.routes.some(isActive)
  }

  /** Picking a model takes its best route; picking a route takes that one. */
  function pickEntry(entry: ModelEntry): void {
    const route = preferredRoute(entry)
    if (!route) return
    pickRoute(route)
  }

  function pickRoute(route: ModelRoute): void {
    if (routeNeedsKey(route) && route.credential) {
      onRequestKey({
        provider: route.providerLabel ?? route.provider,
        variables: route.credential.env
      })
      return
    }
    onPick(route.provider, route.id)
  }

  /**
   * Context window and price for the route a row would take.
   *
   * Both belong to the route rather than the model: Bedrock and a coding-plan
   * endpoint charge their own rates for the same weights, so the number shown
   * is the one the session would actually be billed at.
   */
  function metaLabel(entry: ModelEntry): string {
    const route = preferredRoute(entry)
    if (!route) return ''
    return routeMeta(route)
  }

  function routeMeta(route: ModelRoute): string {
    const parts: string[] = []
    if (route.contextWindow) parts.push(contextLabel(route.contextWindow))
    if (route.pricing) parts.push(priceLabel(route))
    return parts.join('  ')
  }

  function priceLabel(route: ModelRoute): string {
    if (!route.pricing) return ''
    return `$${route.pricing.input}/$${route.pricing.output}`
  }

  /**
   * Open the endpoint list beside the row the pointer is on.
   *
   * The flyout hangs off the menu rather than the row so the list it scrolls
   * inside cannot clip it; the row only contributes where it sits.
   */
  function showEndpoints(entry: ModelEntry, rowElement: HTMLElement): void {
    if (entry.routes.length < 2) {
      flyout = null
      return
    }
    const bounds = root?.getBoundingClientRect()
    if (!bounds) return
    const offset = rowElement.getBoundingClientRect().top - bounds.top
    const highest = Math.max(0, bounds.height - FLYOUT_MAX_HEIGHT)
    flyout = {
      entry,
      top: Math.max(0, Math.min(offset, highest)),
      onLeft: bounds.right + FLYOUT_WIDTH > window.innerWidth
    }
  }

  function contextLabel(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
    return `${Math.round(tokens / 1_000)}K`
  }

  function routeTitle(route: ModelRoute): string {
    const parts = [route.id]
    const meta = routeMeta(route)
    if (meta) parts.push(meta)
    if (route.endpoint) parts.push(route.endpoint)
    if (route.credential?.kind === 'platform') {
      parts.push(`signs in with your ${route.credential.env[0]?.split('_')[0]} credentials`)
    }
    if (routeNeedsKey(route) && route.credential) {
      parts.push(`needs ${route.credential.env.join(' or ')}`)
    }
    return parts.join('\n')
  }
</script>

{#snippet endpointRow(entry: ModelEntry, route: ModelRoute)}
  {@const detail = routeDetail(entry, route)}
  <button
    class="flex w-full items-baseline gap-2 px-2 py-0.5 text-left text-2xs hover:bg-hover {isActive(
      route
    )
      ? 'text-accent'
      : 'text-dim'}"
    title={routeTitle(route)}
    onclick={() => pickRoute(route)}
  >
    <span class="truncate">{route.providerLabel ?? route.provider}</span>
    {#if detail}
      <span class="shrink-0 font-mono opacity-70">{detail}</span>
    {/if}
    {#if routeNeedsKey(route)}
      <span class="shrink-0 text-amber">+key</span>
    {:else if route.credential?.kind === 'platform'}
      <span class="shrink-0 opacity-70">cloud sign-in</span>
    {/if}
    <span class="ml-auto shrink-0 font-mono">{routeMeta(route)}</span>
  </button>
{/snippet}

{#snippet row(entry: ModelEntry)}
  {@const active = entryIsActive(entry)}
  {@const open = flyout?.entry.key === entry.key}
  <!-- Hovering a row opens its endpoints, the way a submenu does; the marker
       says how many there are, so a row with one seller stays a plain row. -->
  <div
    class="px-2 hover:bg-hover"
    class:bg-hover={active || open}
    onmouseenter={(event) => showEndpoints(entry, event.currentTarget)}
  >
    <button
      class="flex w-full items-baseline gap-3 py-1 text-left {active ? 'text-default' : 'text-dim'}"
      title={entry.key}
      onclick={() => pickEntry(entry)}
    >
      <span class="truncate">{entry.label}</span>
      <span class="ml-auto shrink-0 font-mono text-2xs text-dim">{metaLabel(entry)}</span>
      {#if entry.routes.length > 1}
        <span class="shrink-0 text-2xs text-dim">{entry.routes.length} ›</span>
      {/if}
    </button>

    {#if active}
      <div class="truncate pb-1 font-mono text-2xs text-dim">{model}</div>
    {/if}
  </div>
{/snippet}

<div
  class="absolute bottom-full left-0 z-30 mb-1 flex w-80 flex-col rounded-md border border-line bg-elevated shadow-lg"
  bind:this={root}
  onmouseleave={() => (flyout = null)}
>
  {#if switchCostWarning}
    <div
      class="m-1 rounded border border-amber/30 bg-amber-soft px-1.5 py-1 text-2xs leading-snug text-amber"
    >
      {switchCostWarning}
    </div>
  {/if}

  <!-- One field for both jobs: filter the list, or name a model outright. No
       runtime enumerates every id it accepts, so typing one has to work. -->
  <div class="border-b border-line p-1">
    <input
      class="w-full rounded border border-line bg-surface px-1.5 py-1 text-2xs text-default"
      placeholder="search models, or type an id"
      bind:value={query}
      onkeydown={(event) => {
        if (event.key !== 'Enter') return
        if (typedId) onPick(provider, typedId)
        else if (account[0]) pickEntry(account[0])
        else if (rest[0]) pickEntry(rest[0])
      }}
    />
  </div>

  <FloatingScrollbar class="max-h-96" onscroll={() => (flyout = null)}>
    <div class="py-1">
      {#each account as entry (entry.key)}
        {@render row(entry)}
      {/each}

      {#if rest.length > 0}
        <button
          class="mt-1 flex w-full items-center gap-1 border-t border-line px-2 pt-1 text-2xs text-dim hover:text-default"
          onclick={() => (showAll = !restOpen)}
        >
          <span>{restOpen ? '▾' : '▸'}</span>
          <span>{rest.length} more, billed to another account</span>
        </button>
        {#if restOpen}
          {#each rest as entry (entry.key)}
            {@render row(entry)}
          {/each}
        {/if}
      {/if}

      {#if account.length === 0 && rest.length === 0 && !typedId}
        <div class="px-2 py-1 text-2xs text-dim">No models available</div>
      {/if}

      {#if typedId}
        <button
          class="flex w-full flex-col items-start px-2 py-1 text-left hover:bg-hover"
          onclick={() => onPick(provider, typedId)}
        >
          <span class="text-dim">Run this id as typed</span>
          <span class="max-w-full truncate font-mono text-2xs text-default">{typedId}</span>
        </button>
      {/if}

      <!-- Whatever no catalog lists: a gateway, a company proxy, a local model
           behind one. Grove needs the URL; the models come from the endpoint. -->
      <button
        class="mt-1 flex w-full items-center gap-1 border-t border-line px-2 pt-1 text-2xs text-dim hover:text-default"
        onclick={onAddEndpoint}
      >
        + Add an endpoint of your own
      </button>
    </div>
  </FloatingScrollbar>

  <!-- The endpoints of the hovered model, priced one by one: the same weights
       cost different money from Bedrock, a gateway and Anthropic itself. -->
  {#if flyout}
    <div
      class="absolute z-40 w-72 rounded-md border border-line bg-elevated shadow-lg {flyout.onLeft
        ? 'right-full mr-1'
        : 'left-full ml-1'}"
      style="top: {flyout.top}px"
    >
      <div class="truncate border-b border-line px-2 py-1 text-2xs text-dim">
        {flyout.entry.label} · {flyout.entry.routes.length} endpoints
      </div>
      <FloatingScrollbar class="max-h-60">
        <div class="py-1">
          {#each sortedRoutes(flyout.entry) as route (route.provider + route.id)}
            {@render endpointRow(flyout.entry, route)}
          {/each}
        </div>
      </FloatingScrollbar>
    </div>
  {/if}
</div>
