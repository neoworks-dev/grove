<script lang="ts">
  // The model picker: one row per model, with the routes that reach it.
  //
  // Models come first because that is what a person means — "Fable 5.1" — while
  // the route (Anthropic, Bedrock, Vertex, a coding-plan endpoint) is which
  // seller serves it, under an id only that seller uses. A model with one route
  // shows it as a caption; a model with several offers them as chips, and the
  // one a session is on is the one lit.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import {
    matchesQuery,
    preferredRoute,
    routeLabel,
    routeReady
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
    if (!routeReady(route) && route.credential) {
      onRequestKey(route.credential.env)
      return
    }
    onPick(route.provider, route.id)
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
    if (!routeReady(route) && route.credential) {
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
        <div class="px-2 py-1 hover:bg-hover" class:bg-hover={entryIsActive(entry)}>
          <button
            class="flex w-full items-baseline gap-2 text-left {entryIsActive(entry)
              ? 'text-default'
              : 'text-dim'}"
            onclick={() => pickEntry(entry)}
          >
            <span class="truncate">{entry.label}</span>
            <span class="ml-auto shrink-0 text-2xs text-dim">{metaLabel(entry)}</span>
          </button>

          {#if entry.routes.length === 1}
            <!-- Nothing to choose between: the id is the only thing left to say. -->
            <div class="truncate font-mono text-2xs text-dim">{routeLabel(entry.routes[0])}</div>
          {:else}
            <div class="mt-0.5 flex flex-wrap gap-1">
              {#each entry.routes as route (route.provider + route.id)}
                <button
                  class="rounded border px-1 text-2xs {isActive(route)
                    ? 'border-accent text-accent'
                    : 'border-line text-dim hover:text-default'}"
                  class:opacity-60={!routeReady(route)}
                  title={routeTitle(route)}
                  onclick={() => pickRoute(route)}
                >
                  {#if !routeReady(route)}<span class="text-amber">⚠</span>{/if}
                  {route.provider}
                </button>
              {/each}
            </div>
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
