<script lang="ts">
  // A tool call the agent is blocked on.
  //
  // The harness parks its loop until this is answered, so the card replaces the
  // composer rather than sitting beside it — there is nothing else worth doing
  // until it is dealt with. The choices are a numbered list: Tab and the arrow
  // keys move, a digit jumps straight to one, and Enter confirms, because
  // answering these is the most repeated action in the pane.

  import Icon from '@iconify/svelte'
  import Info from 'phosphor-svelte/lib/Info'
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple'
  import { fileIcon } from '../../../../lib/icons'
  import { diffLines, statsOf } from '../../../../lib/agents/diff'
  import { labelFor } from '../../../../lib/agents/tools'
  import type { ToolItem } from '../../../../lib/agents/transcript'
  import type { ConfirmationResult, ToolInfo } from '../../../../lib/agents/types'
  import type { ReviewBatch } from '../../../../../../shared/types'

  let {
    item,
    tool,
    batch,
    onDecide,
    onShowChange
  }: {
    item: ToolItem
    tool: ToolInfo | undefined
    // The gated review staged for this call, when the write is being held as a
    // diff in the editor. Its files are what the call is about to change.
    batch: ReviewBatch | null
    onDecide: (result: ConfirmationResult, reason?: string) => void
    onShowChange: () => void
  } = $props()

  let denyReasonMode = $state(false)
  let denyReason = $state('')
  let index = $state(0)
  let rootEl = $state<HTMLDivElement>()

  const label = $derived(labelFor(tool?.display, item.input))
  const reason = $derived(tool?.summary || tool?.description || 'This tool needs your approval')

  /** The file the call would change, with what it adds and removes. */
  const change = $derived.by(() => {
    const file = batch?.files[0]
    if (!file) return null
    const stats = statsOf(diffLines(file.baseline, file.current))
    return { relPath: file.relPath, added: stats.added, removed: stats.removed }
  })

  const fileName = $derived(change ? change.relPath.split('/').pop() || change.relPath : '')

  interface Choice {
    label: string
    detail: string
    run: () => void
  }

  const choices = $derived.by<Choice[]>(() => {
    const list: Choice[] = [
      { label: 'Allow', detail: 'Allow only this time', run: () => onDecide('allow') },
      {
        label: 'Always allow in this session',
        detail: `Do not ask again for ${item.name}`,
        run: () => onDecide('always_session')
      }
    ]
    if (batch) {
      list.push({
        label: 'Show the diff',
        detail: 'Open the proposed change in the editor',
        run: onShowChange
      })
    }
    list.push({ label: 'Deny', detail: 'Reject it for now', run: () => onDecide('deny') })
    list.push({
      label: 'Deny with reason',
      detail: 'Say why, so the agent can try something else',
      run: () => (denyReasonMode = true)
    })
    return list
  })

  // Focus the card so the keys below reach it.
  $effect(() => {
    if (!denyReasonMode) queueMicrotask(() => rootEl?.focus())
  })

  function move(step: number): void {
    const count = choices.length
    if (count === 0) return
    index = (index + step + count) % count
  }

  function onKey(event: KeyboardEvent): void {
    if (denyReasonMode) return
    if (event.key === 'ArrowDown' || event.key === 'Tab') {
      event.preventDefault()
      move(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choices[index]?.run()
      return
    }
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
      event.preventDefault()
      index = digit - 1
      choices[index].run()
    }
  }
</script>

<div
  bind:this={rootEl}
  class="rounded-md border border-line bg-elevated p-3 outline-none"
  tabindex="-1"
  onkeydown={onKey}
>
  <div class="text-xs font-medium text-default">Permission required</div>
  <div class="mt-1.5 text-xs text-muted">{reason}</div>

  <!-- What is waiting, and on what: the file when a diff was staged, else
       whatever the tool says the call is about. -->
  <div class="mt-2 flex min-w-0 items-center gap-2 text-2xs">
    <span class="shrink-0 text-dim"><PencilSimple width="12" height="12" /></span>
    <span class="shrink-0 text-dim">Awaiting approval</span>
    {#if change}
      <Icon icon={fileIcon(fileName)} class="size-3.5 shrink-0" />
      <span class="min-w-0 truncate font-mono text-default">{fileName}</span>
      {#if change.added > 0}<span class="shrink-0 text-green">+{change.added}</span>{/if}
      {#if change.removed > 0}<span class="shrink-0 text-red">−{change.removed}</span>{/if}
    {:else}
      <span class="shrink-0 font-mono text-default">{item.name}</span>
      {#if label}<span class="min-w-0 truncate font-mono text-muted">{label}</span>{/if}
    {/if}
  </div>

  {#if denyReasonMode}
    <textarea
      class="mb-2 mt-2 h-16 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs"
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
    <div class="mt-2 flex flex-col">
      {#each choices as choice, choiceIndex (choice.label)}
        <button
          class="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-hover"
          class:bg-hover={choiceIndex === index}
          onclick={choice.run}
          onmouseenter={() => (index = choiceIndex)}
        >
          <span class="w-3 shrink-0 text-2xs text-dim">{choiceIndex + 1}.</span>
          <span class="shrink-0 font-medium text-default">{choice.label}</span>
          <span class="min-w-0 truncate text-dim">{choice.detail}</span>
        </button>
      {/each}
    </div>

    <div class="mt-2 flex items-center gap-2 border-t border-line pt-2 text-2xs text-dim">
      <Info width="12" height="12" />
      <span class="min-w-0 flex-1 truncate">
        Use Tab / arrow keys to choose, then press Enter to confirm
      </span>
      <button
        class="shrink-0 rounded-md bg-action px-3 py-1 text-xs text-action-fg"
        onclick={() => choices[index]?.run()}
      >
        Confirm
      </button>
    </div>
  {/if}
</div>
