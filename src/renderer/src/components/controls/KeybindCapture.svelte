<script lang="ts">
  // Key-sequence capture. Chords vs sequences need no mode switch: a chord is
  // one keydown with modifiers held, a sequence is several keydowns. Space as
  // the FIRST key inserts the leader; Escape cancels (and is therefore not
  // capturable here — hand-edit settings.json for that); accept via button or
  // ~1s of inactivity.
  import { keymap } from '../../lib/keymap.svelte'
  import {
    stepFromEvent,
    formatSequence,
    isModifierKey,
    type KeyStep,
    type ParsedSequence
  } from '../../lib/keySequence'

  let {
    value,
    onchange,
    disabled = false
  }: { value: string; onchange: (next: string) => void; disabled?: boolean } = $props()

  let capturing = $state(false)
  let leader = $state(false)
  let steps = $state<KeyStep[]>([])
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const draft = $derived<ParsedSequence>({ leader, steps })
  const draftText = $derived(steps.length > 0 || leader ? formatSequence(draft) : '')

  function begin(): void {
    if (disabled) return
    capturing = true
    leader = false
    steps = []
    keymap.captureMode = true
    window.addEventListener('keydown', onCaptureKey, true)
  }

  function finish(save: boolean): void {
    capturing = false
    keymap.captureMode = false
    window.removeEventListener('keydown', onCaptureKey, true)
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (save && draftText) onchange(draftText)
  }

  function scheduleAutoAccept(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => finish(true), 1000)
  }

  function onCaptureKey(event: KeyboardEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      finish(false)
      return
    }
    if (isModifierKey(event.key)) return
    const step = stepFromEvent(event)
    // Unmodified Space as the first key means "leader".
    if (steps.length === 0 && !leader && step.key === 'space' && !step.ctrl && !step.alt && !step.meta) {
      leader = true
      scheduleAutoAccept()
      return
    }
    steps = [...steps, step]
    scheduleAutoAccept()
  }

  function toggleLeader(): void {
    leader = !leader
    scheduleAutoAccept()
  }

  function clearDraft(): void {
    leader = false
    steps = []
    if (idleTimer) clearTimeout(idleTimer)
  }
</script>

{#if !capturing}
  <button
    class="rounded-md border border-line bg-surface px-2 py-1 font-mono text-2xs text-default hover:bg-hover disabled:opacity-50"
    {disabled}
    onclick={begin}
    title="Click, then press the key sequence"
  >
    {value || 'unbound'}
  </button>
{:else}
  <div class="flex items-center gap-1.5">
    <span
      class="min-w-24 rounded-md border border-accent bg-input px-2 py-1 text-center font-mono text-2xs text-default"
    >
      {draftText || 'press keys…'}
    </span>
    <button
      class="rounded-md border border-line px-1.5 py-1 text-2xs {leader
        ? 'bg-accent text-accent-content'
        : 'text-dim hover:text-default'}"
      onclick={toggleLeader}
      title="Prefix with the leader key"
    >
      Leader
    </button>
    <button
      class="rounded-md border border-line px-1.5 py-1 text-2xs text-muted hover:bg-hover"
      onclick={() => finish(true)}
    >
      Accept
    </button>
    <button
      class="rounded-md border border-line px-1.5 py-1 text-2xs text-dim hover:text-default"
      onclick={clearDraft}
    >
      Clear
    </button>
    <button
      class="rounded-md border border-line px-1.5 py-1 text-2xs text-dim hover:text-default"
      onclick={() => finish(false)}
    >
      Cancel
    </button>
  </div>
{/if}
