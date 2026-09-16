<script lang="ts">
  // The status line under the composer: which harness runs the session, what
  // model it will use, how hard it will think, how freely it may act, and when
  // its changes get reviewed.
  //
  // Harness, provider, model and thinking level are session state in the main
  // process, so picking one updates the session. Mode is derived from the same
  // state (see lib/agents/modes.ts) rather than stored here.

  import Icon from '@iconify/svelte'
  import { MODE_DESCRIPTIONS, MODE_LABELS, type AgentMode } from '../../../../lib/agents/modes'
  import { findRoute } from '../../../../lib/agents/modelSelection'
  import ModelMenu from './ModelMenu.svelte'
  import { THINKING_LABELS, THINKING_LEVELS } from '../../../../lib/agents/thinking'
  import type { HarnessInfo, ModelEntry, ThinkingLevel } from '../../../../lib/agents/types'

  let {
    harness,
    harnesses,
    started,
    provider,
    model,
    thinking,
    mode,
    running,
    models,
    reviewMode,
    reviewPause,
    tokensLabel,
    contextTokens,
    onPickHarness,
    onPickModel,
    onRequestKey,
    onAddEndpoint,
    onPickThinking,
    onPickMode,
    onSetReview,
    onInterrupt
  }: {
    harness: string
    harnesses: HarnessInfo[]
    /** Whether the harness has already answered, which fixes the choice. */
    started: boolean
    provider: string
    model: string
    thinking: ThinkingLevel
    mode: AgentMode
    running: boolean
    models: ModelEntry[]
    reviewMode: string
    reviewPause: boolean
    tokensLabel: string
    /** Context the session has already built up, which a model switch re-reads. */
    contextTokens: number
    onPickHarness: (harness: string) => void
    onPickModel: (provider: string, model: string) => void
    /** Ask the user for the key a route needs before it can be taken. */
    onRequestKey: (request: { provider: string; variables: string[] }) => void
    /** Open the editor for an endpoint of the user's own. */
    onAddEndpoint: () => void
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

  const current = $derived(harnesses.find((entry) => entry.id === harness))
  const capabilities = $derived(current?.capabilities)

  function toggle(menu: Menu): void {
    openMenu = openMenu === menu ? null : menu
  }

  function close(): void {
    openMenu = null
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

  /** The model and route the session is on, when the harness still lists them. */
  const selected = $derived(findRoute(models, { provider, model }))

  /**
   * The model, as the harness names it for people ("Claude Fable 5.1"): the
   * route is a detail of how it is reached, not something worth a slot in the
   * status line.
   */
  const modelLabel = $derived.by(() => {
    if (selected) return selected.entry.label
    return model
  })

  /**
   * The id the session actually runs, shown beside the name because the name
   * alone can be an alias — "Default (recommended)" names no model at all, and
   * one model is spelled differently by each provider that serves it.
   */
  const modelId = $derived.by(() => {
    if (model === modelLabel) return ''
    return model
  })

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

  <!-- Harness: which runtime drives this session, and only until it answers. -->
  <div class="relative z-20">
    <button
      class="flex items-center gap-1 rounded border border-line px-2 py-1 hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
      title={started
        ? 'The harness is fixed once a session has started — start a new session to use another'
        : 'The agent runtime this session runs on'}
      disabled={started}
      onclick={() => toggle('harness')}
    >
      {#if current}
        <Icon icon={current.icon} class="size-3.5 shrink-0" />
      {/if}
      <span class="font-medium text-default">{current?.label ?? harness ?? 'harness'}</span>
      {#if !started}
        <span class="text-dim">▾</span>
      {/if}
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

  <!-- Model, then the route that reaches it. -->
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
      <ModelMenu
        {models}
        {provider}
        {model}
        {switchCostWarning}
        onPick={(pickedProvider, pickedModel) => {
          onPickModel(pickedProvider, pickedModel)
          close()
        }}
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

  <!-- Mode -->
  <div class="relative z-20">
    <button
      data-testid="agent-mode-trigger"
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
            data-testid="agent-mode-option"
            data-mode={candidate}
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
