<script lang="ts">
  import { wakeSummary } from '../../../../lib/agents/heldMessages'
  import type { HeldMessage, HeldMessageDecision } from '../../../../lib/agents/types'

  let {
    held,
    onDecide
  }: {
    held: HeldMessage
    onDecide: (decision: HeldMessageDecision) => void
  } = $props()

  // Read when the card is drawn: it says how long the session has slept so
  // far, which is what the decision is about, not a clock to watch.
  const summary = $derived(wakeSummary(held, Date.now()))
</script>

<!-- An agent's message held off this sleeping session rather than waking it:
     who sent what, what waking for it costs, and the three answers. -->
<div class="mb-2 rounded-md border border-amber/30 bg-amber-soft p-2.5 text-2xs">
  <div class="flex min-w-0 items-center gap-2">
    <span class="shrink-0 font-medium text-amber">Held message</span>
    <span class="min-w-0 truncate text-muted">from {held.from}</span>
  </div>
  <div
    class="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap border-l-2 border-line pl-2 text-xs text-default"
  >
    {held.text}
  </div>
  <div class="mt-1.5 text-muted">{summary}</div>
  <div class="mt-2 flex items-center gap-2">
    <button
      class="shrink-0 rounded-md bg-action px-3 py-1 text-xs text-action-fg"
      onclick={() => onDecide('send')}>Send</button
    >
    {#if held.canCompact}
      <button
        class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
        title="Compact the conversation first, so the message is read against a smaller context"
        onclick={() => onDecide('compact_then_send')}>Compact, then send</button
      >
    {/if}
    <button
      class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
      title="Drop the message; the session stays asleep and the sender is told"
      onclick={() => onDecide('reject')}>Reject</button
    >
  </div>
</div>
