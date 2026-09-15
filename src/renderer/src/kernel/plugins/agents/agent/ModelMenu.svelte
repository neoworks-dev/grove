<script lang="ts">
  // The model picker: one line per model.
  //
  // Models come first because that is what a person means — "Fable 5.1" — while
  // the route (Anthropic, Bedrock, Vertex, a coding-plan endpoint) is which
  // seller serves it, under an id only that seller uses. Almost every model has
  // one route worth taking, so routes are drawn for the model a session is on
  // and nowhere else; picking any other model takes its best route.
  //
  // What the account itself can run is a handful of models. The catalog knows
  // fifty more, which is worth having and not worth scrolling past, so they sit
  // behind a fold that any search opens.

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
  let showAll = $state(false)

  const matching = $derived(models.filter((entry) => matchesQuery(entry, query)))

  /** What the signed-in account can run: the short list, always shown. */
  const account = $derived(matching.filter((entry) => entry.routes.some((route) => route.native)))

  /** Everything else the catalog knows, behind the fold until it is asked for. */
  const rest = $derived(matching.filter((entry) => !entry.routes.some((route) => route.native)))

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
      onRequestKey(route.credential.env)
      return
    }
    onPick(route.provider, route.id)
  }

  /** Context window and price, the way model cards quote them. */
  function metaLabel(entry: ModelEntry): string {
    const route = preferredRoute(entry)
    if (!route) return ''
    const parts: string[] = []
    if (route.contextWindow) parts.push(contextLabel(route.contextWindow))
    if (route.pricing) parts.push(`$${route.pricing.input}/$${route.pricing.output}`)
    return parts.join('  ')
  }

  function contextLabel(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
    return `${Math.round(tokens / 1_000)}K`
  }

  function routeTitle(route: ModelRoute): string {
    const parts = [route.id]
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

{#snippet row(entry: ModelEntry)}
  {@const active = entryIsActive(entry)}
  <div class="px-2 hover:bg-hover" class:bg-hover={active}>
    <button
      class="flex w-full items-baseline gap-3 py-1 text-left {active ? 'text-default' : 'text-dim'}"
      title={entry.key}
      onclick={() => pickEntry(entry)}
    >
      <span class="truncate">{entry.label}</span>
      <span class="ml-auto shrink-0 font-mono text-2xs text-dim">{metaLabel(entry)}</span>
    </button>

    <!-- Only the running model has to be exact about which seller and which id,
         and only it offers the others: everywhere else one line is enough. -->
    {#if active}
      <div class="flex flex-wrap items-baseline gap-x-2 pb-1 text-2xs">
        <span class="truncate font-mono text-dim">{model}</span>
        {#each entry.routes as route (route.provider + route.id)}
          <button
            class="truncate {isActive(route) ? 'text-accent' : 'text-dim hover:text-default'}"
            title={routeTitle(route)}
            onclick={() => pickRoute(route)}
          >
            {#if routeNeedsKey(route)}<span class="text-amber">+key</span>{/if}
            {route.provider}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

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
        else if (account[0]) pickEntry(account[0])
        else if (rest[0]) pickEntry(rest[0])
      }}
    />
  </div>

  <FloatingScrollbar class="max-h-96">
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
          <span>{rest.length} more from other providers</span>
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
    </div>
  </FloatingScrollbar>
</div>
