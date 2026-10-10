<script lang="ts">
  // The status line under the composer: which harness runs the session and
  // whether in grove mode, how freely it may act, when its changes get reviewed,
  // and, as plain text, the model and effort it runs with. Those two are changed
  // from the composer with `/model` and `/effort`. The controls wrap onto a second
  // row as the pane narrows rather than squeezing.
  //
  // Harness and grove mode are session state in the main process, so picking one
  // updates the session. Mode is derived from the same state (see
  // lib/agents/modes.ts) rather than stored here.

  import Icon from '@iconify/svelte'
  import StopIcon from 'phosphor-svelte/lib/StopIcon'
  import { MODE_DESCRIPTIONS, MODE_LABELS, type AgentMode } from '../../../../lib/agents/modes'
  import { findRoute } from '../../../../lib/agents/modelSelection'
  import HarnessMenu from './HarnessMenu.svelte'
  import { keepInside } from '../../../../lib/popoverFit'
  import { FAST_MODE_WARNING } from '../../../../lib/agents/composerPicker'
  import { GROVE_MODE_DESCRIPTION } from '../../../../lib/agents/newSession'
  import type { HarnessInfo, ModelEntry, ThinkingLevel } from '../../../../lib/agents/types'

  let {
    harness,
    harnesses,
    started,
    groveMode,
    provider,
    model,
    thinking,
    fastMode,
    mode,
    running,
    models,
    reviewMode,
    tokensLabel,
    costLabel,
    onPickHarness,
    onPickGroveMode,
    onPickFastMode,
    onPickMode,
    onSetReview,
    onInterrupt
  }: {
    harness: string
    harnesses: HarnessInfo[]
    /** Whether the harness has already answered, which fixes the choice. */
    started: boolean
    /** Whether the harness runs on grove's prompt and tools instead of its own. */
    groveMode: boolean
    provider: string
    model: string
    thinking: ThinkingLevel
    /** Whether the harness answers in fast mode. */
    fastMode: boolean
    mode: AgentMode
    running: boolean
    models: ModelEntry[]
    reviewMode: string
    tokensLabel: string
    /** What the session has cost so far, empty when the harness reports none. */
    costLabel: string
    onPickHarness: (harness: string) => void
    onPickGroveMode: (groveMode: boolean) => void
    onPickFastMode: (fastMode: boolean) => void
    onPickMode: (mode: AgentMode) => void
    onSetReview: (key: string, value: string | boolean) => void
    onInterrupt: () => void
  } = $props()

  const MODES: AgentMode[] = ['default', 'plan', 'acceptEdits', 'bypass']

  const REVIEW_MODES = [
    { value: 'pre', label: 'Before writing' },
    { value: 'post', label: 'After writing' }
  ]

  type Menu = 'harness' | 'mode' | 'review'
  let openMenu = $state<Menu | null>(null)

  // The row the menus open from; each is kept inside it, so a control that
  // wrapped towards the pane's right edge does not open a menu off the window.
  let controlsRow = $state<HTMLDivElement>()

  const current = $derived(harnesses.find((entry) => entry.id === harness))
  const capabilities = $derived(current?.capabilities)

  function toggle(menu: Menu): void {
    openMenu = openMenu === menu ? null : menu
  }

  function close(): void {
    openMenu = null
  }

  const reviewLabel = $derived(reviewMode === 'post' ? 'review after' : 'review first')

  /** The model and route the session is on, when the harness still lists them. */
  const selected = $derived(findRoute(models, { provider, model }))

  /**
   * The model, as the harness names it for people ("Claude Fable 5.1"): the
   * route is a detail of how it is reached, not something worth a slot in the
   * status line.
   */
  const modelTitle = $derived.by(() => {
    if (provider) return `${provider} · ${model}`
    return model
  })

  const modelLabel = $derived.by(() => {
    if (selected) return selected.entry.label
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

<div class="relative flex flex-wrap items-center gap-2 text-2xs" bind:this={controlsRow}>
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
      {#if groveMode}
        <Icon icon="grove:grove" class="size-3.5 shrink-0" aria-label="Grove mode" />
      {/if}
      {#if !started}
        <span class="text-dim">▾</span>
      {/if}
    </button>
    {#if openMenu === 'harness'}
      <HarnessMenu
        {harnesses}
        {harness}
        boundary={controlsRow}
        onPick={(picked) => {
          onPickHarness(picked)
          close()
        }}
      >
        {#if capabilities?.groveMode}
          <div class="mt-1 border-t border-line pt-1">
            <button
              class="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover"
              class:text-default={groveMode}
              class:text-dim={!groveMode}
              title={GROVE_MODE_DESCRIPTION}
              aria-pressed={groveMode}
              onclick={() => {
                onPickGroveMode(!groveMode)
                close()
              }}
            >
              <span class="w-3">{groveMode ? '✓' : ''}</span>
              <Icon icon="grove:grove" class="size-3.5 shrink-0" />
              Grove mode
            </button>
          </div>
        {/if}
      </HarnessMenu>
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
        use:keepInside={controlsRow}
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
        use:keepInside={controlsRow}
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
      </div>
    {/if}
  </div>

  {#if tokensLabel}
    <span class="truncate font-mono text-dim" title="Context used">{tokensLabel}</span>
  {/if}
  {#if costLabel}
    <span class="font-mono text-dim" title="Session cost so far">{costLabel}</span>
  {/if}

  <!-- Model and effort are shown, not chosen here: /model and /effort pick them from
       a list above the prompt. -->
  <span
    class="ml-auto min-w-0 truncate text-dim"
    data-testid="agent-model-state"
    title={modelTitle}
  >
    <span class="font-medium text-default">{modelLabel}</span>
    {#if capabilities?.thinking !== false}
      <span> · {thinking}</span>
    {/if}
  </span>

  <!-- Fast mode is flagged for as long as it is on, because every turn in it uses up limits faster. -->
  {#if fastMode}
    <button
      class="flex items-center gap-1 rounded border border-amber/50 bg-amber-soft px-2 py-1 text-amber hover:bg-hover"
      data-testid="fast-mode-chip"
      title={`${FAST_MODE_WARNING} Click to turn it off (alt+o).`}
      onclick={() => onPickFastMode(false)}
    >
      <span class="font-medium">Fast</span>
      <span>uses limits faster</span>
    </button>
  {/if}

  {#if running && capabilities?.interrupt !== false}
    <button
      class="flex items-center rounded border border-line px-1.5 py-1 text-red hover:bg-hover"
      title="Stop (Esc)"
      aria-label="Stop"
      onclick={onInterrupt}
    >
      <StopIcon size={12} weight="fill" />
    </button>
  {/if}
</div>
