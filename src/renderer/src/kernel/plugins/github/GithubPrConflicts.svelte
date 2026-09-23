<script lang="ts">
  // The conflict a pull request has with its base, and the way out of it; and
  // a checkout that has fallen behind the pull request.
  //
  // Three conflict states, in the order they happen: GitHub reports a conflict
  // and it can be merged down here; the merge is open and its conflicts are
  // being resolved in Git Changes; the merge is committed and only a push makes
  // GitHub agree. Behind the pull request, the checkout is offered a
  // fast-forward, or told why it is left alone.
  import {
    github,
    pushPrBranch,
    refreshPrCheckout,
    resolvePrConflicts,
    updatePrCheckout
  } from './store.svelte'
  import { untrack } from 'svelte'
  import { store, selectWorktree } from '../../../lib/store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import type { GithubItemDetail } from '../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  // DIRTY is GitHub's word for "this no longer merges cleanly".
  const conflicting = $derived(detail.mergeStateStatus === 'DIRTY')
  const checkout = $derived(github.prCheckouts[detail.number])
  const resolving = $derived(checkout?.mergeInProgress === true)
  const behind = $derived(!resolving && (checkout?.behind || 0) > 0)
  // A checkout both ahead and behind has diverged; pushing it would be refused.
  const pushable = $derived(!resolving && !behind && (checkout?.ahead || 0) > 0)

  // Fetched once per pull request opened: for a conflicting one, for a checkout
  // still holding a resolution that was never pushed, and for one the pull
  // request has moved on from. The detail is reloaded far more often than that,
  // and each fetch is a network round trip.
  let refreshedNumber: number | null = null
  $effect(() => {
    const number = detail.number
    if (detail.kind !== 'pull' || number === refreshedNumber) return
    refreshedNumber = number
    untrack(() => void refreshPrCheckout(detail))
  })

  function showConflicts(): void {
    if (!checkout?.worktreeId) return
    void selectWorktree(checkout.worktreeId)
    layout.ensurePane('changes')
  }

  const worktreeName = $derived(
    store.worktrees.find((worktree) => worktree.id === checkout?.worktreeId)?.name || ''
  )
</script>

{#if detail.kind === 'pull' && (conflicting || resolving || behind || pushable)}
  <div class="mt-2 rounded-md border border-line bg-canvas px-2 py-1.5 text-2xs">
    {#if resolving}
      <div class="flex items-center gap-2">
        <span class="text-amber">
          Merging <span class="font-mono">{detail.baseRefName}</span> into
          <span class="font-mono">{worktreeName}</span> ·
          {#if checkout.unresolved === 0}
            all conflicts resolved
          {:else}
            {checkout.unresolved} file{checkout.unresolved === 1 ? '' : 's'} left
          {/if}
        </span>
        <button
          class="ml-auto shrink-0 rounded border border-line px-2 py-0.5 hover:bg-hover"
          onclick={showConflicts}
        >
          Show conflicts
        </button>
      </div>
    {:else if behind}
      <div class="flex items-center gap-2">
        <span class="text-dim">
          <span class="font-mono">{worktreeName}</span> is {checkout.behind}
          commit{checkout.behind === 1 ? '' : 's'} behind the pull request.
          {#if checkout.updateBlockedReason}
            <span class="text-amber">Left as it is: {checkout.updateBlockedReason}.</span>
          {/if}
        </span>
        {#if !checkout.updateBlockedReason}
          <button
            class="ml-auto shrink-0 rounded bg-action px-2 py-0.5 text-action-fg disabled:opacity-50"
            disabled={github.prCheckoutBusy}
            onclick={() => updatePrCheckout(detail)}
          >
            Update checkout
          </button>
        {/if}
      </div>
    {:else if pushable}
      <div class="flex items-center gap-2">
        <span class="text-dim">
          {checkout.ahead} commit{checkout.ahead === 1 ? '' : 's'} the pull request does not have yet.
          {#if checkout.pushTarget}
            They go to <span class="font-mono">{checkout.pushTarget.repository}</span>
            <span class="font-mono">{checkout.pushTarget.branch}</span>.
          {:else}
            <span class="text-amber">Cannot push: {checkout.blockedReason}.</span>
          {/if}
        </span>
        {#if checkout.pushTarget}
          <button
            class="ml-auto shrink-0 rounded bg-action px-2 py-0.5 text-action-fg disabled:opacity-50"
            disabled={github.prCheckoutBusy}
            onclick={() => pushPrBranch(detail.number)}
          >
            Push to pull request
          </button>
        {/if}
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <span class="text-amber">
          Conflicts with <span class="font-mono">{detail.baseRefName}</span>.
          {#if checkout && !checkout.pushTarget}
            <span class="text-dim">
              The resolution will stay local — {checkout.blockedReason}.
            </span>
          {/if}
        </span>
        <button
          class="ml-auto shrink-0 rounded bg-action px-2 py-0.5 text-action-fg disabled:opacity-50"
          disabled={github.prCheckoutBusy}
          onclick={() => resolvePrConflicts(detail)}
        >
          {github.prCheckoutBusy ? 'Merging…' : 'Resolve conflicts'}
        </button>
      </div>
    {/if}
  </div>
{/if}
