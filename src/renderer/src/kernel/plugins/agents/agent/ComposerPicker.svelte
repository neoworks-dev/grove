<script lang="ts">
  // The list `/model`, `/effort` and `/fast` open directly above the composer,
  // inline in the agent pane. Arrow keys move between rows, Enter picks, and
  // Escape closes it and gives the keyboard back to the prompt.

  import { onDestroy, onMount, tick } from 'svelte'
  import { keyDispatch, KeyPriority } from '../../../../lib/keyDispatch'
  import {
    FAST_MODE_WARNING,
    focusPickerStart,
    stepPickerFocus,
    type PickerKind
  } from '../../../../lib/agents/composerPicker'
  import { THINKING_LABELS, THINKING_LEVELS } from '../../../../lib/agents/thinking'
  import type { ModelEntry, ThinkingLevel } from '../../../../lib/agents/types'
  import ModelMenu from './ModelMenu.svelte'

  let {
    kind,
    models,
    provider,
    model,
    thinking,
    fastMode,
    contextTokens,
    supportsThinking,
    supportsFastMode,
    onPickModel,
    onRequestKey,
    onAddEndpoint,
    onPickThinking,
    onPickFastMode,
    onClose
  }: {
    kind: PickerKind
    models: ModelEntry[]
    provider: string
    model: string
    thinking: ThinkingLevel
    fastMode: boolean
    /** Context the session has built up, which a model switch re-reads. */
    contextTokens: number
    /** Whether the session's harness has thinking levels to choose. */
    supportsThinking: boolean
    /** Whether the session's harness has a fast mode to switch. */
    supportsFastMode: boolean
    onPickModel: (provider: string, model: string) => void
    onRequestKey: (request: { provider: string; variables: string[] }) => void
    onAddEndpoint: () => void
    onPickThinking: (level: ThinkingLevel) => void
    onPickFastMode: (fastMode: boolean) => void
    /** Closes the picker; `refocus` says whether the prompt takes the keyboard back. */
    onClose: (refocus: boolean) => void
  } = $props()

  let root = $state<HTMLDivElement>()

  /** What a model switch costs: the new model has none of this conversation cached. */
  const switchCostWarning = $derived.by(() => {
    if (contextTokens <= 0) return ''
    return `Switching re-reads this conversation (~${formatTokens(contextTokens)} tokens) at full price: the new model has none of it cached.`
  })

  /** A token count as the status line writes it. */
  function formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens)
    return `${(tokens / 1000).toFixed(1)}k`
  }

  /** Picks a row and hands the keyboard back to the prompt. */
  function pick(action: () => void): void {
    action()
    onClose(true)
  }

  /**
   * Claims the picker's keys while the keyboard is inside it. Through the dispatcher
   * rather than an element listener, since the pane's bindings run in the capture
   * phase and would take Escape first.
   */
  function onKey(event: KeyboardEvent): boolean {
    if (!root || !root.contains(document.activeElement)) return false
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
    let action: (() => void) | undefined
    if (event.key === 'ArrowDown') action = () => stepPickerFocus(root as HTMLElement, 1)
    if (event.key === 'ArrowUp') action = () => stepPickerFocus(root as HTMLElement, -1)
    if (event.key === 'Escape') action = () => onClose(true)
    if (!action) return false
    event.preventDefault()
    event.stopPropagation()
    action()
    return true
  }

  /** Clicking away closes the picker without taking the keyboard from wherever the click went. */
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && root?.contains(next)) return
    onClose(false)
  }

  const stopKeys = keyDispatch.subscribe(KeyPriority.menu, onKey)
  onDestroy(stopKeys)

  onMount(() => {
    void tick().then(() => {
      if (root) focusPickerStart(root)
    })
  })
</script>

{#snippet row(label: string, description: string, current: boolean, onpick: () => void)}
  <button
    class="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    data-current={current}
    onclick={() => pick(onpick)}
  >
    <span class="flex w-full items-center gap-1.5">
      <span class="font-medium text-default">{label}</span>
      {#if current}
        <span class="ml-auto text-dim">✓</span>
      {/if}
    </span>
    {#if description}
      <span class="leading-snug text-dim">{description}</span>
    {/if}
  </button>
{/snippet}

<div
  bind:this={root}
  class="absolute bottom-full left-0 right-0 z-20 mb-1"
  data-testid="composer-picker"
  data-kind={kind}
  role="presentation"
  tabindex="-1"
  onfocusout={onFocusOut}
>
  {#if kind === 'model'}
    <ModelMenu
      inline
      {models}
      {provider}
      {model}
      {switchCostWarning}
      onPick={(pickedProvider, pickedModel) => pick(() => onPickModel(pickedProvider, pickedModel))}
      onRequestKey={(request) => pick(() => onRequestKey(request))}
      onAddEndpoint={() => pick(onAddEndpoint)}
    />
  {:else}
    <div
      class="overflow-hidden rounded-md border border-line bg-elevated py-1 shadow-lg"
      role="menu"
    >
      {#if kind === 'effort'}
        <div class="px-2 py-1 text-2xs text-dim">Reasoning effort</div>
        {#if supportsThinking}
          {#each THINKING_LEVELS as level (level)}
            {@render row(THINKING_LABELS[level], '', level === thinking, () =>
              onPickThinking(level)
            )}
          {/each}
        {:else}
          <div class="px-2 py-1 text-xs text-dim">This harness has no reasoning effort to set.</div>
        {/if}
      {:else}
        <div class="px-2 py-1 text-2xs text-dim">Fast mode</div>
        {#if supportsFastMode}
          {@render row('On', FAST_MODE_WARNING, fastMode, () => onPickFastMode(true))}
          {@render row('Off', '', !fastMode, () => onPickFastMode(false))}
        {:else}
          <div class="px-2 py-1 text-xs text-dim">This harness has no fast mode.</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
