<script lang="ts">
  // The status line under the composer: which harness runs the session, what
  // model it will use, how hard it will think, how freely it may act, and when
  // its changes get reviewed.
  //
  // Harness, provider, model and thinking level are session state in the main
  // process, so picking one updates the session. Mode is derived from the same
  // state (see lib/agents/modes.ts) rather than stored here.

  import Icon from '@iconify/svelte'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { MODE_DESCRIPTIONS, MODE_LABELS, type AgentMode } from '../../../../lib/agents/modes'
  import { modelName, modelWireId } from '../../../../lib/agents/modelSelection'
  import { THINKING_LABELS, THINKING_LEVELS } from '../../../../lib/agents/thinking'
  import type {
    HarnessInfo,
    ModelInfo,
    ProviderModels,
    ThinkingLevel
  } from '../../../../lib/agents/types'

  let {
    harness,
    harnesses,
    provider,
    model,
    thinking,
    mode,
    running,
    providers,
    reviewMode,
    reviewPause,
    tokensLabel,
    contextTokens,
    onPickHarness,
    onPickModel,
    onPickThinking,
    onPickMode,
    onSetReview,
    onInterrupt
  }: {
    harness: string
    harnesses: HarnessInfo[]
    provider: string
    model: string
    thinking: ThinkingLevel
    mode: AgentMode
    running: boolean
    providers: ProviderModels[]
    reviewMode: string
    reviewPause: boolean
    tokensLabel: string
    /** Context the session has already built up, which a model switch re-reads. */
    contextTokens: number
    onPickHarness: (harness: string) => void
    onPickModel: (provider: string, model: string) => void
    onPickThinking: (level: ThinkingLevel) => void
    onPickMode: (mode: AgentMode) => void
    onSetReview: (key: string, value: string | boolean) => void
    onInterrupt: () => void
  } = $props()

  const MODES: AgentMode[] = ['default', 'plan', 'acceptEdits', 'bypass']

  const REVIEW_MODES = [
    { value: 'pre', label: 'Before writing' },
    { value: 'post', label: 'After writing' }
  ]

  type Menu = 'harness' | 'model' | 'thinking' | 'mode' | 'review'
  let openMenu = $state<Menu | null>(null)
  let submenuProvider = $state<string | null>(null)
  // A harness that cannot enumerate its models (Codex) takes one by name.
  let typedModel = $state('')

  const current = $derived(harnesses.find((entry) => entry.id === harness))
  const capabilities = $derived(current?.capabilities)

  function submitTypedModel(): void {
    const trimmed = typedModel.trim()
    if (trimmed.length === 0) return
    onPickModel(provider, trimmed)
    typedModel = ''
    close()
  }

  function toggle(menu: Menu): void {
    openMenu = openMenu === menu ? null : menu
    if (openMenu !== 'model') submenuProvider = null
  }

  function close(): void {
    openMenu = null
    submenuProvider = null
  }

  const reviewLabel = $derived(reviewMode === 'post' ? 'review after' : 'review first')

  /**
   * What a model switch costs.
   *
   * The new model has none of this conversation cached, so the first turn after
   * a switch re-reads all of it at the full input rate — on a long session that
   * is real money, and it is not obvious from a picker that looks like every
   * other dropdown in the status line.
   */
  const switchCostWarning = $derived.by(() => {
    if (contextTokens <= 0) return ''
    return `Switching re-reads this conversation (~${formatTokens(contextTokens)} tokens) at full price: the new model has none of it cached.`
  })

  function formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    return `${(tokens / 1000).toFixed(1)}k`
  }

  /** The catalog row the session's model is selected from, when it lists one. */
  const selected = $derived.by(() => {
    for (const entry of providers) {
      if (entry.provider !== provider) continue
      const match = entry.models.find((candidate) => candidate.id === model)
      if (match) return match
    }
    return null
  })

  /**
   * The model, as the harness names it for people ("Opus (1M context)"): the
   * provider is a detail of the cascade that picks it, not something worth a
   * slot in the status line.
   */
  const modelLabel = $derived.by(() => {
    if (selected) return modelName(selected)
    return model
  })

  /**
   * The model the session actually talks to, shown beside the name because the
   * name alone can be an alias — "Default (recommended)" names no model at all.
   * Suppressed when it would only repeat the name.
   */
  const modelId = $derived.by(() => {
    if (!selected) return ''
    const id = modelWireId(selected)
    if (id === modelLabel) return ''
    return id
  })

  /** The provider's own name, falling back to the id the harness keys it by. */
  function providerLabel(entry: ProviderModels): string {
    if (entry.label) return entry.label
    return entry.provider
  }

  /** Whether grove has no credential for a provider that asks for one. */
  function needsCredential(entry: ProviderModels): boolean {
    if (!entry.credential) return false
    return !entry.credential.present
  }

  /** Where a provider's sessions go, and what they need before they can go. */
  function providerHint(entry: ProviderModels): string {
    const parts: string[] = []
    if (entry.endpoint) parts.push(entry.endpoint)
    if (needsCredential(entry)) {
      parts.push(`no credential — set ${entry.credential?.env.join(' or ')}`)
    }
    if (parts.length === 0) return entry.provider
    return parts.join(' · ')
  }

  /** What a model row says on hover: its capabilities, or failing that its id. */
  function modelHint(candidate: ModelInfo): string {
    if (candidate.description) return candidate.description
    return modelWireId(candidate)
  }

  // Modes read as how far they step away from "ask": neutral, then the theme's
  // accent, then its two warning tones. Every one is a theme token, so they
  // change with the palette instead of sitting on top of it.
  const MODE_COLOR: Record<AgentMode, string> = {
    default: 'text-muted',
    plan: 'text-violet',
    acceptEdits: 'text-amber',
    bypass: 'text-red'
  }
</script>

<div class="relative flex items-center gap-2 text-2xs">
  <!-- Backdrop closes any open menu on outside click. -->
  {#if openMenu}
    <button
      class="fixed inset-0 z-10 cursor-default"
      tabindex="-1"
      aria-label="Close menu"
      onclick={close}
    ></button>
  {/if}

  <!-- Harness: which runtime drives this session. -->
  <div class="relative z-20">
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="The agent runtime this session runs on"
      onclick={() => toggle('harness')}
    >
      {#if current}
        <Icon icon={current.icon} class="size-3.5 shrink-0" />
      {/if}
      <span class="font-medium text-default">{current?.label ?? harness ?? 'harness'}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'harness'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#each harnesses as entry (entry.id)}
          <button
            class="flex w-full items-start gap-2 px-2 py-1 text-left hover:bg-hover disabled:opacity-50 {entry.id ===
            harness
              ? 'text-default'
              : 'text-dim'}"
            disabled={!entry.available}
            title={entry.detail ?? entry.description}
            onclick={() => {
              onPickHarness(entry.id)
              close()
            }}
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
        {#if harnesses.length === 0}
          <div class="px-2 py-1 text-2xs text-dim">No harness is mounted</div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Provider → model cascade: each provider row flies out its own models. -->
  <div class="relative z-20">
    <button
      class="flex items-center gap-1.5 rounded border border-line px-2 py-1 hover:bg-hover"
      title={provider ? `${provider} · ${model}` : model}
      onclick={() => toggle('model')}
    >
      <span class="max-w-[12rem] truncate font-medium text-default">{modelLabel}</span>
      {#if modelId}
        <span class="max-w-[12rem] truncate font-mono text-dim">{modelId}</span>
      {/if}
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'model'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#if switchCostWarning}
          <div
            class="mx-1 mb-1 rounded border border-amber/30 bg-amber-soft px-1.5 py-1 text-2xs leading-snug text-amber"
          >
            {switchCostWarning}
          </div>
        {/if}
        <!-- Always typeable: no runtime enumerates every model it will accept,
             and a harness that enumerates none takes one only this way. -->
        <div class="px-2 py-1">
          <input
            class="w-full rounded border border-line bg-surface px-1.5 py-1 text-2xs text-default"
            placeholder="model id"
            title="Run any model id this harness accepts, listed or not"
            bind:value={typedModel}
            onkeydown={(event) => {
              if (event.key === 'Enter') submitTypedModel()
            }}
          />
        </div>
        {#each providers as entry (entry.provider)}
          <div
            class="relative"
            role="presentation"
            onmouseenter={() => (submenuProvider = entry.provider)}
          >
            <button
              class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover {entry.provider ===
              provider
                ? 'text-default'
                : 'text-dim'}"
              title={providerHint(entry)}
            >
              <span class="truncate">{providerLabel(entry)}</span>
              <!-- A provider grove has no key for still lists its models; the
                   turn is what fails, so the warning belongs on the way in. -->
              {#if needsCredential(entry)}
                <span class="shrink-0 text-amber">key</span>
              {/if}
              <span class="ml-auto text-dim">›</span>
            </button>
            {#if submenuProvider === entry.provider}
              <div
                class="absolute bottom-0 left-full z-40 ml-1 w-56 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
              >
                <FloatingScrollbar class="max-h-72">
                  <div class="py-1">
                    {#each entry.models as candidate (candidate.id)}
                      {@const name = modelName(candidate)}
                      {@const wireId = modelWireId(candidate)}
                      <button
                        class="flex w-full flex-col items-start px-2 py-1 text-left hover:bg-hover {entry.provider ===
                          provider && candidate.id === model
                          ? 'text-default'
                          : 'text-dim'}"
                        title={modelHint(candidate)}
                        onclick={() => {
                          onPickModel(entry.provider, candidate.id)
                          close()
                        }}
                      >
                        <!-- Two lines, because a harness names its models for
                             humans ("Opus (1M context)") but every row can be an
                             alias: the second line is the model it resolves to. -->
                        <span class="max-w-full truncate">{name}</span>
                        {#if wireId !== name}
                          <span class="max-w-full truncate font-mono text-2xs text-dim">
                            {wireId}
                          </span>
                        {/if}
                      </button>
                    {/each}
                    {#if entry.models.length === 0}
                      <div class="px-2 py-1 text-2xs text-dim">No models available</div>
                    {/if}
                  </div>
                </FloatingScrollbar>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Mode -->
  <div class="relative z-20">
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="How much the agent may do without asking (shift+tab)"
      onclick={() => toggle('mode')}
    >
      <span class="font-medium {MODE_COLOR[mode]}">{MODE_LABELS[mode]}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'mode'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#each MODES as candidate (candidate)}
          <button
            class="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-hover"
            onclick={() => {
              onPickMode(candidate)
              close()
            }}
          >
            <span class="flex w-full items-center gap-1.5">
              <span class={MODE_COLOR[candidate]}>{MODE_LABELS[candidate]}</span>
              {#if candidate === mode}
                <span class="ml-auto text-dim">✓</span>
              {/if}
            </span>
            <span class="leading-snug text-dim">{MODE_DESCRIPTIONS[candidate]}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Review: when the agent's edits are reviewed, and how they are shown -->
  <div class="relative z-20">
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="How the agent's file changes are reviewed"
      onclick={() => toggle('review')}
    >
      <span class="font-medium text-muted">{reviewLabel}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'review'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        <div class="px-2 py-1 text-2xs text-dim">Review changes</div>
        {#each REVIEW_MODES as option (option.value)}
          <button
            class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {reviewMode ===
            option.value
              ? 'text-default'
              : 'text-dim'}"
            onclick={() => onSetReview('workbench.reviewMode', option.value)}
          >
            {option.label}
          </button>
        {/each}

        <div class="mt-1 border-t border-line pt-1">
          <button
            class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover {reviewPause
              ? 'text-default'
              : 'text-dim'}"
            title="Hold the agent when it submits a batch, instead of letting it carry on"
            onclick={() => onSetReview('workbench.reviewPause', !reviewPause)}
          >
            <span class="w-3">{reviewPause ? '✓' : ''}</span>
            Pause agent for review
          </button>
        </div>
      </div>
    {/if}
  </div>

  {#if tokensLabel}
    <span class="truncate font-mono text-dim" title="Context used">{tokensLabel}</span>
  {/if}

  <!-- Thinking: hidden for a harness that has no thinking levels. -->
  <div class="relative z-20 ml-auto" class:hidden={capabilities?.thinking === false}>
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover"
      title="Reasoning effort (ctrl+tab)"
      onclick={() => toggle('thinking')}
    >
      <span class="font-medium text-default">{THINKING_LABELS[thinking]}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'thinking'}
      <div
        class="absolute bottom-full right-0 z-30 mb-1 w-40 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#each THINKING_LEVELS as level (level)}
          <button
            class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {level === thinking
              ? 'text-default'
              : 'text-dim'}"
            onclick={() => {
              onPickThinking(level)
              close()
            }}
          >
            {THINKING_LABELS[level]}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if running && capabilities?.interrupt !== false}
    <button
      class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
      onclick={onInterrupt}
    >
      ■ Stop
    </button>
  {/if}
</div>
