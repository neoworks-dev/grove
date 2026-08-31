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
  import { MODE_LABELS, type AgentMode } from '../../../../lib/agents/modes'
  import type { HarnessInfo, ProviderModels, ThinkingLevel } from '../../../../lib/agents/types'

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
    onPickHarness: (harness: string) => void
    onPickModel: (provider: string, model: string) => void
    onPickThinking: (level: ThinkingLevel) => void
    onPickMode: (mode: AgentMode) => void
    onSetReview: (key: string, value: string | boolean) => void
    onInterrupt: () => void
  } = $props()

  const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
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

  const MODE_COLOR: Record<AgentMode, string> = {
    default: 'text-muted',
    plan: 'text-blue',
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
      title="Provider and model for this session"
      onclick={() => toggle('model')}
    >
      <span class="font-medium text-default">{provider}</span>
      <span class="text-dim">·</span>
      <span class="max-w-[10rem] truncate text-muted">{model}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'model'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#if providers.length === 0}
          <!-- Nothing to enumerate: this harness takes a model by name. -->
          <div class="px-2 py-1">
            <input
              class="w-full rounded border border-line bg-surface px-1.5 py-1 text-2xs text-default"
              placeholder="model id"
              bind:value={typedModel}
              onkeydown={(event) => {
                if (event.key === 'Enter') submitTypedModel()
              }}
            />
          </div>
        {/if}
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
            >
              <span class="truncate">{entry.provider}</span>
              <span class="ml-auto text-dim">›</span>
            </button>
            {#if submenuProvider === entry.provider}
              <div
                class="absolute bottom-0 left-full z-40 ml-1 w-56 overflow-hidden rounded-md border border-line bg-elevated shadow-lg"
              >
                <FloatingScrollbar class="max-h-72">
                  <div class="py-1">
                    {#each entry.models as candidate (candidate.id)}
                      <button
                        class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {entry.provider ===
                          provider && candidate.id === model
                          ? 'text-default'
                          : 'text-dim'}"
                        title={candidate.id}
                        onclick={() => {
                          onPickModel(entry.provider, candidate.id)
                          close()
                        }}
                      >
                        <!-- Harnesses label their models for humans ("Opus (1M
                             context)"); the id stays in the tooltip. -->
                        <span class="truncate">{candidate.label || candidate.id}</span>
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
      title="How much the agent may do without asking"
      onclick={() => toggle('mode')}
    >
      <span class="font-medium {MODE_COLOR[mode]}">{MODE_LABELS[mode]}</span>
      <span class="text-dim">▾</span>
    </button>
    {#if openMenu === 'mode'}
      <div
        class="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-line bg-elevated py-1 shadow-lg"
      >
        {#each MODES as candidate (candidate)}
          <button
            class="flex w-full items-center px-2 py-1 text-left hover:bg-hover {candidate === mode
              ? 'text-default'
              : 'text-dim'}"
            onclick={() => {
              onPickMode(candidate)
              close()
            }}
          >
            <span class={MODE_COLOR[candidate]}>{MODE_LABELS[candidate]}</span>
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
      title="Thinking level"
      onclick={() => toggle('thinking')}
    >
      <span class="font-medium text-default">{thinking}</span>
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
            {level}
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
