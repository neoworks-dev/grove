<script lang="ts">
  // What replaces the list's filter row once rows are ticked: how many, and the
  // things worth doing to all of them at once. A tick box with nothing behind
  // it would just be decoration.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import TagIcon from 'phosphor-svelte/lib/TagIcon'
  import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import GithubLabelPicker from './GithubLabelPicker.svelte'
  import { dialogs } from '../../../lib/dialogs.svelte'
  import { github, addLabelsToChecked, checkAllVisible, runBulkAction } from './store.svelte'

  let labelling = $state(false)
  let pending = $state<string[]>([])

  const count = $derived(github.checked.length)
  const all = $derived(count > 0 && count === github.items.length)

  /** Bulk state changes hit several items at once, so both directions ask. */
  async function confirmBulk(action: 'close' | 'reopen'): Promise<void> {
    const verb = action === 'close' ? 'Close' : 'Reopen'
    const picked = await dialogs.confirm({
      title: `${verb} ${count} item${count === 1 ? '' : 's'}?`,
      body: github.checked.map((number) => `#${number}`).join(', '),
      actions: [
        { id: 'go', label: verb, kind: action === 'close' ? 'danger' : 'primary' },
        { id: 'cancel', label: 'Cancel' }
      ]
    })
    if (picked !== 'go') return
    await runBulkAction(action)
  }

  async function applyLabels(): Promise<void> {
    const labels = pending
    labelling = false
    pending = []
    await addLabelsToChecked(labels)
  }
</script>

<div class="flex shrink-0 flex-col gap-1.5 border-b border-line bg-raised px-2 py-1.5">
  <div class="flex items-center gap-2">
    <Checkbox
      size="sm"
      checked={all}
      onchange={() => checkAllVisible(!all)}
      aria-label="Select all"
    />
    <span class="flex-1 text-2xs text-dim">{count} of {github.items.length} selected</span>

    <button
      class="rounded p-1 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={github.busy}
      title="Add labels"
      aria-label="Add labels"
      onclick={() => (labelling = !labelling)}
    >
      <TagIcon size={13} />
    </button>
    <button
      class="rounded p-1 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={github.busy}
      title="Close selected"
      aria-label="Close selected"
      onclick={() => confirmBulk('close')}
    >
      <XCircleIcon size={13} />
    </button>
    <button
      class="rounded p-1 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={github.busy}
      title="Reopen selected"
      aria-label="Reopen selected"
      onclick={() => confirmBulk('reopen')}
    >
      <ArrowCounterClockwiseIcon size={13} />
    </button>
    <button
      class="rounded px-1.5 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
      onclick={() => checkAllVisible(false)}
    >
      Clear
    </button>
  </div>

  {#if labelling}
    <GithubLabelPicker
      selected={pending}
      disabled={github.busy}
      onchange={(next) => (pending = next)}
    />
    <button
      class="self-start rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
      disabled={github.busy || pending.length === 0}
      onclick={applyLabels}
    >
      {github.busy ? 'Applying…' : `Add to ${count}`}
    </button>
  {/if}
</div>
