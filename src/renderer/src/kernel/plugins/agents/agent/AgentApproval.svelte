<script lang="ts">
  // A tool call the agent is blocked on.
  //
  // The harness parks its loop until this is answered, so the card
  // replaces the composer rather than sitting beside it — there is nothing else
  // worth doing until it is dealt with. Arrow keys and Enter work, because
  // answering these is the most repeated action in the pane.

  import { labelFor } from '../../../../lib/agents/tools'
  import type { ToolItem } from '../../../../lib/agents/transcript'
  import type { ConfirmationResult, ToolInfo } from '../../../../lib/agents/types'

  let {
    item,
    tool,
    hasDiff,
    onDecide,
    onShowChange
  }: {
    item: ToolItem
    tool: ToolInfo | undefined
    // A gated review is showing this change as a diff in the editor.
    hasDiff: boolean
    onDecide: (result: ConfirmationResult, reason?: string) => void
    onShowChange: () => void
  } = $props()

  let denyReasonMode = $state(false)
  let denyReason = $state('')
  let index = $state(0)
  let rootEl = $state<HTMLDivElement>()

  const label = $derived(labelFor(tool?.display, item.input))

  interface Choice {
    label: string
    class: string
    run: () => void
  }

  const choices = $derived.by<Choice[]>(() => {
    const list: Choice[] = [
      { label: 'Yes', class: 'bg-green text-action-fg', run: () => onDecide('allow') },
      {
        label: "Yes, don't ask again this session",
        class: 'bg-violet text-action-fg',
        run: () => onDecide('always_session')
      }
    ]
    if (hasDiff) {
      list.push({
        label: 'Show the diff in the editor',
        class: 'border border-line hover:bg-hover',
        run: onShowChange
      })
    }
    list.push({
      label: 'No',
      class: 'border border-line text-red hover:bg-hover',
      run: () => onDecide('deny')
    })
    list.push({
      label: 'No, with reason…',
      class: 'border border-line text-dim hover:bg-hover',
      run: () => (denyReasonMode = true)
    })
    return list
  })

  // Focus the card so arrow keys and Enter reach it.
  $effect(() => {
    if (!denyReasonMode) queueMicrotask(() => rootEl?.focus())
  })

  function onKey(event: KeyboardEvent): void {
    if (denyReasonMode) return
    const count = choices.length
    if (count === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      index = (index + 1) % count
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      index = (index - 1 + count) % count
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choices[index].run()
    }
  }
</script>

<div
  bind:this={rootEl}
  class="rounded-md border border-amber/40 bg-amber-soft p-2 outline-none"
  tabindex="-1"
  onkeydown={onKey}
>
  <div class="mb-2 text-xs text-default">
    Run <span class="font-mono font-semibold">{item.name}</span>?
  </div>
  {#if label}
    <div class="mb-2 truncate font-mono text-2xs text-muted">{label}</div>
  {/if}
  {#if hasDiff}
    <div class="mb-2 text-2xs text-muted">Proposed change shown as a diff in the editor →</div>
  {/if}

  {#if denyReasonMode}
    <textarea
      class="mb-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
      placeholder="Reason for denying…"
      bind:value={denyReason}
    ></textarea>
    <div class="flex gap-2">
      <button
        class="rounded-md bg-red px-3 py-1 text-xs text-action-fg"
        onclick={() => onDecide('deny', denyReason)}
      >
        Deny with reason
      </button>
      <button
        class="rounded-md border border-line px-3 py-1 text-xs hover:bg-hover"
        onclick={() => (denyReasonMode = false)}
      >
        Cancel
      </button>
    </div>
  {:else}
    <div class="flex flex-col gap-1.5">
      {#each choices as choice, choiceIndex (choice.label)}
        <button
          class="rounded-md px-3 py-1.5 text-left text-xs outline-none {choice.class} {choiceIndex ===
          index
            ? 'ring-2 ring-default'
            : ''}"
          onclick={choice.run}
        >
          {choice.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
