<script lang="ts">
  // The item's metadata, as GitHub's right-hand rail: what it carries, with the
  // labels editable in place. Assignees and milestones are read-only for now —
  // they want the same treatment and are tracked separately.
  import GearIcon from 'phosphor-svelte/lib/GearIcon'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubLabelPicker from './GithubLabelPicker.svelte'
  import { github, applyLabels } from './store.svelte'
  import type { GithubItemDetail } from '../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  let editingLabels = $state(false)

  // What the picker holds while it is open: the item's own labels until the
  // user touches them, then whatever they have chosen so far.
  let pending = $state<string[] | null>(null)

  const chosen = $derived.by<string[]>(() => {
    if (pending !== null) return pending
    return detail.labels.map((label) => label.name)
  })

  function openPicker(): void {
    pending = detail.labels.map((label) => label.name)
    editingLabels = true
  }

  async function closePicker(): Promise<void> {
    const next = pending
    editingLabels = false
    pending = null
    if (next) await applyLabels(next)
  }
</script>

<div class="flex flex-col gap-4 text-2xs">
  <section class="flex flex-col gap-1.5">
    <div class="flex items-center justify-between">
      <h3 class="font-medium text-default">Labels</h3>
      <button
        class="rounded p-0.5 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
        disabled={github.busy}
        title={editingLabels ? 'Done' : 'Edit labels'}
        aria-label={editingLabels ? 'Apply label changes' : 'Edit labels'}
        onclick={() => (editingLabels ? closePicker() : openPicker())}
      >
        <GearIcon size={12} />
      </button>
    </div>

    {#if editingLabels}
      <GithubLabelPicker
        selected={chosen}
        disabled={github.busy}
        onchange={(next) => (pending = next)}
      />
      <button
        class="self-start rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
        disabled={github.busy}
        onclick={closePicker}
      >
        {github.busy ? 'Saving…' : 'Apply'}
      </button>
    {:else if detail.labels.length > 0}
      <div class="flex flex-wrap gap-1">
        {#each detail.labels as label (label.name)}
          <GithubLabelPill {label} />
        {/each}
      </div>
    {:else}
      <p class="text-dim">None yet</p>
    {/if}
  </section>

  <section class="flex flex-col gap-1.5">
    <h3 class="font-medium text-default">Assignees</h3>
    {#if detail.assignees.length > 0}
      <p class="text-dim">{detail.assignees.join(', ')}</p>
    {:else}
      <p class="text-dim">No one</p>
    {/if}
  </section>

  {#if detail.kind === 'pull'}
    <section class="flex flex-col gap-1.5">
      <h3 class="font-medium text-default">Branch</h3>
      <p class="truncate font-mono text-dim" title="{detail.headRefName} → {detail.baseRefName}">
        {detail.headRefName} → {detail.baseRefName}
      </p>
    </section>
  {/if}
</div>
