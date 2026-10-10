<script lang="ts">
  // The line under the controls: the permission mode the session is in, hints for the
  // keys that matter while it works, and a passing warning when the context runs low.
  // The keys come from the keymap, so a rebound key is the one that is named.

  import { onDestroy } from 'svelte'
  import Kbd from '../../../../components/Kbd.svelte'
  import { MODE_DESCRIPTIONS, MODE_LABELS, type AgentMode } from '../../../../lib/agents/modes'
  import {
    contextIsLow,
    contextLowMessage,
    footerHintsOf
  } from '../../../../lib/agents/footerHints'

  let {
    sessionId,
    mode,
    running,
    commandRunning,
    contextRatio,
    cycleModeKeys,
    backgroundKeys
  }: {
    sessionId: string
    mode: AgentMode
    running: boolean
    commandRunning: boolean
    /** The share of the context window used, 0 to 1. */
    contextRatio: number
    cycleModeKeys: string[]
    backgroundKeys: string[]
  } = $props()

  /** How long the context warning stays up once it has appeared. */
  const WARNING_MS = 10000

  // What the glyph says about each mode: paused for the one that asks, play for the ones that do not.
  const MODE_GLYPH: Record<AgentMode, string> = {
    default: '⏸',
    plan: '◎',
    acceptEdits: '⏵⏵',
    bypass: '⏵⏵'
  }

  const MODE_COLOR: Record<AgentMode, string> = {
    default: 'text-muted',
    plan: 'text-violet',
    acceptEdits: 'text-amber',
    bypass: 'text-red'
  }

  const hints = $derived(footerHintsOf({ running, commandRunning, cycleModeKeys, backgroundKeys }))

  let warningVisible = $state(false)
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  // The session and state the warning was last decided for, so it shows once per crossing.
  let warnedSession = ''
  let wasLow = false

  // The warning shows when the context crosses the line, then goes by itself.
  $effect(() => {
    const low = contextIsLow(contextRatio)
    const session = sessionId
    if (session !== warnedSession) {
      warnedSession = session
      wasLow = false
      warningVisible = false
      clearTimeout(warningTimer)
    }
    if (low && !wasLow) showWarning()
    if (!low) {
      warningVisible = false
      clearTimeout(warningTimer)
    }
    wasLow = low
  })

  /** Puts the warning up and takes it down again after WARNING_MS. */
  function showWarning(): void {
    warningVisible = true
    clearTimeout(warningTimer)
    warningTimer = setTimeout(() => {
      warningVisible = false
    }, WARNING_MS)
  }

  onDestroy(() => clearTimeout(warningTimer))
</script>

<div
  class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-dim"
  data-testid="agent-hints"
>
  <span class="flex items-center gap-1 {MODE_COLOR[mode]}" title={MODE_DESCRIPTIONS[mode]}>
    <span aria-hidden="true">{MODE_GLYPH[mode]}</span>
    <span data-testid="agent-hints-mode">{MODE_LABELS[mode]} mode</span>
  </span>
  {#each hints as hint (hint.text)}
    <span class="flex items-center gap-1">
      <Kbd>{hint.keys}</Kbd>
      {hint.text}
    </span>
  {/each}
  {#if warningVisible}
    <span class="w-full text-amber" role="status" data-testid="agent-context-warning">
      {contextLowMessage(contextRatio)}
    </span>
  {/if}
</div>
