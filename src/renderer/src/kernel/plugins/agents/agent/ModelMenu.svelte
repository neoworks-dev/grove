<script lang="ts">
  // The model picker: one row per model, with the routes that reach it.
  //
  // Models come first because that is what a person means — "Fable 5.1" — while
  // the route (Anthropic, Bedrock, Vertex, a coding-plan endpoint) is which
  // seller serves it, under an id only that seller uses. A row is therefore one
  // model, one line of sellers, and nothing else: the exact id is shown only for
  // the model actually running, since that is the only place it has to be read.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import {
    matchesQuery,
    preferredRoute,
    routeNeedsKey
  } from '../../../../lib/agents/modelSelection'
  import type { ModelEntry, ModelRoute } from '../../../../lib/agents/types'

  let {
    models,
    provider,
    model,
    switchCostWarning,
    onPick,
    onRequestKey
  }: {
    models: ModelEntry[]
    /** The provider and id of the route the session is on. */
    provider: string
    model: string
    /** What a switch costs, when there is a conversation to re-read. */
    switchCostWarning: string
    onPick: (provider: string, model: string) => void
    /** Ask for a credential a route needs before it can be taken. */
    onRequestKey: (variables: string[]) => void
  } = $props()

  let query = $state('')
  // The row whose routes are all showing, if any.
  let expanded = $state<string | null>(null)

  // How many routes a row shows before it collapses the rest behind a count.
  const VISIBLE_ROUTES = 3

  const matching = $derived(models.filter((entry) => matchesQuery(entry, query)))

  /** What was typed, when it names no model grove knows — run it anyway. */
  const typedId = $derived.by(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return ''
    const known = models.some((entry) =>
      entry.routes.some((route) => route.id === trimmed && route.provider === provider)
    )
    if (known) return ''
    return trimmed
  })

  function isActive(route: ModelRoute): boolean {
    return route.provider === provider && route.id === model
  }

  function entryIsActive(entry: ModelEntry): boolean {
    return entry.routes.some(isActive)
  }

  /** Picking the model takes its best route; picking a chip takes that one. */
  function pickEntry(entry: ModelEntry): void {
    const route = preferredRoute(entry)
    if (!route) return
    pickRoute(route)
  }

  function pickRoute(route: ModelRoute): void {
    if (routeNeedsKey(route) && route.credential) {
      onRequestKey(route.credential.env)
      return
    }
    onPick(route.provider, route.id)
  }

  /**
   * Which routes are worth drawing on a row nobody has opened.
   *
   * A model reachable eight ways is still one model; the rest are one more
   * click away rather than four more lines of chips.
   */
  function shownRoutes(entry: ModelEntry): ModelRoute[] {
    if (expanded === entry.key) return entry.routes
    return entry.routes.slice(0, VISIBLE_ROUTES)
  }

  function hiddenCount(entry: ModelEntry): number {
    if (expanded === entry.key) return 0
    return Math.max(0, entry.routes.length - VISIBLE_ROUTES)
  }

  /** The context window, said the way model cards say it. */
  function contextLabel(route: ModelRoute): string {
    if (!route.contextWindow) return ''
    if (route.contextWindow >= 1_000_000) return `${Math.round(route.contextWindow / 1_000_000)}M`
    return `${Math.round(route.contextWindow / 1_000)}K`
  }

  /** Input and output price per million tokens, which is how they are quoted. */
  function priceLabel(route: ModelRoute): string {
    if (!route.pricing) return ''
    return `$${route.pricing.input}/$${route.pricing.output}`
  }

  function metaLabel(entry: ModelEntry): string {
    const route = preferredRoute(entry)
    if (!route) return ''
    return [contextLabel(route), priceLabel(route)].filter(Boolean).join(' · ')
  }

  function routeTitle(route: ModelRoute): string {
    const parts = [`${route.provider} · ${route.id}`]
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

<div
  class="absolute bottom-full left-0 z-30 mb-1 flex w-80 flex-col rounded-md border border-line bg-elevated shadow-lg"
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
        else if (matching[0]) pickEntry(matching[0])
      }}
    />
  </div>

  <FloatingScrollbar class="max-h-96">
    <div class="py-1">
      {#each matching as entry (entry.key)}
        {@const routes = shownRoutes(entry)}
        {@const hidden = hiddenCount(entry)}
        <div class="px-2 py-1 hover:bg-hover" class:bg-hover={entryIsActive(entry)}>
          <button
            class="flex w-full items-baseline gap-2 text-left {entryIsActive(entry)
              ? 'text-default'
              : 'text-dim'}"
            title={entry.key}
            onclick={() => pickEntry(entry)}
          >
            <span class="truncate">{entry.label}</span>
            <span class="ml-auto shrink-0 text-2xs text-dim">{metaLabel(entry)}</span>
          </button>

          <!-- Routes stay on one quiet line: which sellers serve this model,
               not their ids, which only the picked one has to be exact about. -->
          <div class="flex flex-wrap items-baseline gap-x-1.5 text-2xs">
            {#each routes as route (route.provider + route.id)}
              <button
                class="truncate {isActive(route) ? 'text-accent' : 'text-dim hover:text-default'}"
                class:opacity-60={routeNeedsKey(route)}
                title={routeTitle(route)}
                onclick={() => pickRoute(route)}
              >
                {#if routeNeedsKey(route)}<span class="text-amber">+key</span>{/if}
                {route.provider}
              </button>
            {/each}
            {#if hidden > 0}
              <button class="text-dim hover:text-default" onclick={() => (expanded = entry.key)}>
                +{hidden}
              </button>
            {/if}
          </div>

          <!-- The exact id matters for the model actually running, and nowhere else. -->
          {#if entryIsActive(entry)}
            <div class="truncate font-mono text-2xs text-dim">{model}</div>
          {/if}
        </div>
      {/each}

      {#if matching.length === 0 && !typedId}
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
    </div>
  </FloatingScrollbar>
</div>
