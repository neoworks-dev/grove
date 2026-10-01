<script lang="ts">
  // The runtime, model and effort a spawned agent will start on, in its
  // approval. Each is a control like the composer's status line, so the user
  // can change what the agent runs on before agreeing to it.

  import Icon from '@iconify/svelte'
  import { catalog } from '../../../../lib/agents/catalog.svelte'
  import { findRoute } from '../../../../lib/agents/modelSelection'
  import { THINKING_LABELS } from '../../../../lib/agents/thinking'
  import { keepInside } from '../../../../lib/popoverFit'
  import type { SpawnChoice } from '../../../../lib/agents/spawnChoice'
  import type { SpawnTarget, ThinkingLevel } from '../../../../lib/agents/types'
  import ModelMenu from './ModelMenu.svelte'

  let {
    target,
    choice = $bindable(),
    onRequestKey,
    onAddEndpoint,
    onDone
  }: {
    /** What the tool resolved the call to, which the defaults are described from. */
    target: SpawnTarget
    choice: SpawnChoice
    onRequestKey: (request: { provider: string; variables: string[] }) => void
    onAddEndpoint: () => void
    /** A menu closed, so the approval can take the keyboard back. */
    onDone: () => void
  } = $props()

  // `off` is what leaving effort out means, so it is offered as the default.
  const SPAWN_EFFORTS: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

  type Menu = 'harness' | 'model' | 'effort'
  let openMenu = $state<Menu | null>(null)
  let row = $state<HTMLDivElement>()

  const harness = $derived(catalog.harnessNamed(choice.harness))
  const models = $derived.by(() => {
    if (!choice.harness) return []
    return catalog.modelsOf(choice.harness)
  })

  // The model list of a runtime the pane is not showing is fetched on demand.
  $effect(() => {
    const harnessId = choice.harness
    if (!harnessId) return
    if (catalog.byHarness[harnessId]) return
    void catalog.prefetch(harnessId)
  })

  const selected = $derived.by(() => {
    if (!choice.model) return null
    return findRoute(models, { provider: choice.provider ?? '', model: choice.model })
  })

  /** The model as people name it, falling back to its id while the list loads. */
  const modelLabel = $derived.by(() => {
    if (selected) return selected.entry.label
    if (choice.model) return choice.model
    return 'Runtime default'
  })

  // What the runtime says its default currently is: Claude Code's `default`
  // names the model it stands for. Only true while the model is the one the
  // tool described.
  const modelNote = $derived.by(() => {
    if (!choice.modelIsDefault) return ''
    if (choice.model !== target.model) return 'default'
    if (target.modelDescription) return target.modelDescription
    return 'default'
  })

  const effortLabel = $derived.by(() => {
    if (choice.effort) return THINKING_LABELS[choice.effort]
    return 'Default effort'
  })

  /** Opens one menu, or closes it when it is the one already open. */
  function toggle(menu: Menu): void {
    if (openMenu === menu) {
      close()
      return
    }
    openMenu = menu
  }

  function close(): void {
    openMenu = null
    onDone()
  }

  /** Another runtime starts on its own default model; the old one may not exist there. */
  function pickHarness(harnessId: string): void {
    const defaults = catalog.byHarness[harnessId]?.default
    let provider: string | null = null
    let model: string | null = null
    if (defaults) {
      provider = defaults.provider
      model = defaults.model
    }
    choice = { ...choice, harness: harnessId, provider, model, modelIsDefault: true }
    close()
  }

  function pickModel(provider: string, model: string): void {
    choice = { ...choice, provider, model, modelIsDefault: false }
    close()
  }

  function pickEffort(effort: ThinkingLevel | null): void {
    choice = { ...choice, effort }
    close()
  }

  /**
   * Keys typed into an open menu — its search, its arrows — are the menu's, not
   * the approval's numbered choices. Escape closes the menu, not the approval.
   */
  function onKey(event: KeyboardEvent): void {
    if (!openMenu) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="relative flex flex-wrap items-center gap-1.5 text-2xs"
  bind:this={row}
  onkeydown={onKey}
>
  {#if openMenu}
    <button
      class="fixed inset-0 z-10 cursor-default"
      tabindex="-1"
      aria-label="Close menu"
      onclick={close}
    ></button>
  {/if}

  <div class="relative z-20">
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="The runtime the agent runs on"
      onclick={() => toggle('harness')}
    >
      {#if harness}
        <Icon icon={harness.icon} class="size-3.5 shrink-0" />
      {/if}
      <span class="font-medium text-default">{harness?.label ?? choice.harness ?? 'Default runtime'}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'harness'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-md border border-line bg-elevated py-1 shadow-lg"
        use:keepInside={row}
      >
        {#each catalog.harnesses as entry (entry.id)}
          <button
            class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-hover disabled:opacity-50"
            class:text-default={entry.id === choice.harness}
            class:text-dim={entry.id !== choice.harness}
            disabled={!entry.available}
            title={entry.detail ?? entry.description}
            onclick={() => pickHarness(entry.id)}
          >
            <Icon icon={entry.icon} class="mt-0.5 size-3.5 shrink-0" />
            <span class="flex min-w-0 flex-col items-start">
              <span>{entry.label}</span>
              {#if !entry.available}
                <span class="truncate text-2xs text-red">{entry.detail ?? 'unavailable'}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="relative z-20 min-w-0">
    <button
      class="flex min-w-0 items-center gap-1.5 rounded border border-line px-2 py-1 hover:bg-hover"
      title={choice.provider ? `${choice.provider} · ${choice.model}` : (choice.model ?? '')}
      onclick={() => toggle('model')}
    >
      <span class="min-w-0 max-w-[12rem] truncate font-medium text-default">{modelLabel}</span>
      {#if modelNote}
        <span class="min-w-0 max-w-[10rem] truncate text-dim">{modelNote}</span>
      {/if}
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'model'}
      <ModelMenu
        {models}
        provider={choice.provider ?? ''}
        model={choice.model ?? ''}
        switchCostWarning=""
        boundary={row}
        onPick={pickModel}
        onRequestKey={(request) => {
          onRequestKey(request)
          close()
        }}
        onAddEndpoint={() => {
          onAddEndpoint()
          close()
        }}
      />
    {/if}
  </div>

  <div class="relative z-20" class:hidden={harness?.capabilities?.thinking === false}>
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="Reasoning effort"
      onclick={() => toggle('effort')}
    >
      <span class="font-medium text-default">{effortLabel}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'effort'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-40 rounded-md border border-line bg-elevated py-1 shadow-lg"
        use:keepInside={row}
      >
        <button
          class="flex w-full items-center px-2 py-1 text-left hover:bg-hover"
          class:text-default={choice.effort === null}
          class:text-dim={choice.effort !== null}
          onclick={() => pickEffort(null)}
        >
          Runtime default
        </button>
        {#each SPAWN_EFFORTS as level (level)}
          <button
            class="flex w-full items-center px-2 py-1 text-left hover:bg-hover"
            class:text-default={level === choice.effort}
            class:text-dim={level !== choice.effort}
            onclick={() => pickEffort(level)}
          >
            {THINKING_LABELS[level]}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
