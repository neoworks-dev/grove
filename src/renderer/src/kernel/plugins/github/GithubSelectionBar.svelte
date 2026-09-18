<script lang="ts">
  // What replaces the list's header once rows are ticked: how many, and the
  // three things GitHub lets you do to a selection — mark, label, assign. A
  // tick box with nothing behind it would just be decoration.
  import Checkbox from '@neoworks-dev/ui/Checkbox'
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import CircleIcon from 'phosphor-svelte/lib/CircleIcon'
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon'
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon'
  import GithubAvatar from './GithubAvatar.svelte'
  import GithubLabelPill from './GithubLabelPill.svelte'
  import GithubMenu from './GithubMenu.svelte'
  import { dialogs } from '../../../lib/dialogs.svelte'
  import {
    github,
    addLabelsToChecked,
    assignChecked,
    checkAllVisible,
    loadLabels,
    loadMentionables,
    runBulkAction
  } from './store.svelte'
  import type { GithubCloseReason } from '../../../../../shared/types'

  let pendingLabels = $state<string[]>([])
  let pendingAssignees = $state<string[]>([])

  const count = $derived(github.checked.length)
  const all = $derived(count > 0 && count === github.items.length)

  $effect(() => {
    void loadLabels()
    void loadMentionables()
  })

  /**
   * Marking hits every ticked item at once, so it asks first — the difference
   * between closing one issue by mistake and closing thirty is the whole reason
   * this bar needs a guard the single-item actions do not.
   */
  async function mark(action: 'close' | 'reopen', reason?: GithubCloseReason): Promise<void> {
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
    await runBulkAction(action, reason)
  }

  async function applyLabels(close: () => void): Promise<void> {
    const labels = pendingLabels
    pendingLabels = []
    close()
    await addLabelsToChecked(labels)
  }

  async function applyAssignees(close: () => void): Promise<void> {
    const logins = pendingAssignees
    pendingAssignees = []
    close()
    await assignChecked(logins)
  }

  function togglePending(list: string[], value: string): string[] {
    if (list.includes(value)) return list.filter((entry) => entry !== value)
    return [...list, value]
  }
</script>

<div class="flex shrink-0 items-center gap-1 border-b border-line bg-raised px-2 py-1.5">
  <Checkbox
    size="sm"
    checked={all}
    onchange={() => checkAllVisible(!all)}
    aria-label="Select all"
  />
  <span class="mr-1 shrink-0 text-2xs text-dim">{count} of {github.items.length}</span>

  <GithubMenu label="Mark as" disabled={github.busy}>
    {#snippet children(close)}
      <button
        class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
        onclick={() => {
          close()
          void mark('reopen')
        }}
      >
        <span class="text-green"><CircleIcon size={12} /></span>
        Open
      </button>
      <button
        class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
        onclick={() => {
          close()
          void mark('close', 'completed')
        }}
      >
        <span class="text-violet"><CheckCircleIcon size={12} /></span>
        Completed
      </button>
      <button
        class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
        onclick={() => {
          close()
          void mark('close', 'not planned')
        }}
      >
        <span class="text-dim"><ProhibitIcon size={12} /></span>
        Not planned
      </button>
    {/snippet}
  </GithubMenu>

  <GithubMenu label="Label" disabled={github.busy}>
    {#snippet children(close)}
      <FloatingScrollbar class="max-h-56">
        <div class="flex flex-col">
          {#each github.labels as label (label.name)}
            <button
              class="flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-hover"
              onclick={() => (pendingLabels = togglePending(pendingLabels, label.name))}
            >
              <Checkbox size="sm" checked={pendingLabels.includes(label.name)} />
              <GithubLabelPill {label} />
            </button>
          {/each}
        </div>
      </FloatingScrollbar>
      <button
        class="mt-1 w-full rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
        disabled={pendingLabels.length === 0}
        onclick={() => applyLabels(close)}
      >
        Add to {count}
      </button>
    {/snippet}
  </GithubMenu>

  <GithubMenu label="Assign" disabled={github.busy}>
    {#snippet children(close)}
      <FloatingScrollbar class="max-h-56">
        <div class="flex flex-col">
          {#each github.mentionables as actor (actor.login)}
            <button
              class="flex items-center gap-2 rounded px-1.5 py-1 text-left text-2xs text-default hover:bg-hover"
              onclick={() => (pendingAssignees = togglePending(pendingAssignees, actor.login))}
            >
              <Checkbox size="sm" checked={pendingAssignees.includes(actor.login)} />
              <GithubAvatar {actor} size={14} />
              <span class="truncate">{actor.login}</span>
            </button>
          {/each}
          {#if github.mentionables.length === 0}
            <p class="px-1.5 py-1 text-2xs text-dim">No assignable people.</p>
          {/if}
        </div>
      </FloatingScrollbar>
      <button
        class="mt-1 w-full rounded-md bg-action px-2 py-0.5 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
        disabled={pendingAssignees.length === 0}
        onclick={() => applyAssignees(close)}
      >
        Assign to {count}
      </button>
    {/snippet}
  </GithubMenu>

  <button
    class="ml-auto shrink-0 rounded px-1.5 py-0.5 text-2xs text-dim hover:bg-hover hover:text-default"
    onclick={() => checkAllVisible(false)}
  >
    Clear
  </button>
</div>
