<script lang="ts">
  // The conflict a pull request has with its base, and the way out of it.
  //
  // Three states, in the order they happen: GitHub reports a conflict and it can
  // be merged down here; the merge is open and its conflicts are being resolved
  // in Git Changes; the merge is committed and only a push makes GitHub agree.
  import { github, loadPrCheckoutState, pushPrBranch, resolvePrConflicts } from './store.svelte'
  import { store, selectWorktree } from '../../../lib/store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import type { GithubItemDetail } from '../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  // DIRTY is GitHub's word for "this no longer merges cleanly".
  const conflicting = $derived(detail.mergeStateStatus === 'DIRTY')
  const checkout = $derived(github.prCheckouts[detail.number])
  const resolving = $derived(checkout?.mergeInProgress === true)
  const pushable = $derived(!resolving && (checkout?.ahead || 0) > 0)

  // Loaded for a conflicting pull request, and for one whose checkout may still
  // be holding a resolution that was never pushed.
  $effect(() => {
    const number = detail.number
    if (detail.kind !== 'pull') return
    void loadPrCheckoutState(number)
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

{#if detail.kind === 'pull' && (conflicting || resolving || pushable)}
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
