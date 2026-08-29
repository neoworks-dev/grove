<script lang="ts">
  // The status line under the composer: what will run, how hard it will think, how
  // freely it may act, and when its changes get reviewed.
  //
  // Provider, model and thinking level are session state on the server, so picking
  // one PATCHes the session. Mode is derived from the same session state (see
  // lib/nib/modes.ts) rather than stored here.

  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { MODE_LABELS, type AgentMode } from '../../../../lib/nib/modes'
  import type { ProviderModels, ThinkingLevel } from '../../../../lib/nib/types'

  let {
    provider,
    model,
    thinking,
    mode,
    running,
    providers,
    reviewMode,
    reviewPause,
    tokensLabel,
    onPickModel,
    onPickThinking,
    onPickMode,
    onSetReview,
    onInterrupt
  }: {
    provider: string
    model: string
    thinking: ThinkingLevel
    mode: AgentMode
    running: boolean
    providers: ProviderModels[]
    reviewMode: string
    reviewPause: boolean
    tokensLabel: string
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

  type Menu = 'model' | 'thinking' | 'mode' | 'review'
  let openMenu = $state<Menu | null>(null)
  let submenuProvider = $state<string | null>(null)

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
                        onclick={() => {
                          onPickModel(entry.provider, candidate.id)
                          close()
                        }}
                      >
                        <span class="truncate">{candidate.id}</span>
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

  <!-- Thinking -->
  <div class="relative z-20 ml-auto">
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

  {#if running}
    <button
      class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
      onclick={onInterrupt}
    >
      ■ Stop
    </button>
  {/if}
</div>
