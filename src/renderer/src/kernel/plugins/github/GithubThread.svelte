<script lang="ts">
  // The right-hand half of the GitHub pane: the open item's header, its body,
  // the comment thread (issue comments and review summaries merged in time
  // order) and the composer. Actions are whatever GitHub allows for the item's
  // current state; merging asks for confirmation in the store.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { github, postComment, runAction } from './store.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import { ageLabel, availableActions, labelIsDark, reviewLabel, reviewTone } from './filter'
  import { renderMarkdown } from '../../../lib/markdown'
  import type { GithubItemAction } from '../../../../../shared/types'

  let draft = $state('')

  const detail = $derived(github.detail)
  const actions = $derived.by<GithubItemAction[]>(() => {
    if (!detail) return []
    return availableActions({ kind: detail.kind, state: detail.state, isDraft: detail.isDraft })
  })

  const actionLabels: Record<GithubItemAction, string> = {
    close: 'Close',
    reopen: 'Reopen',
    ready: 'Ready for review',
    merge: 'Merge'
  }

  async function submitComment(): Promise<void> {
    if (draft.trim().length === 0) return
    const posted = await postComment(draft)
    if (posted) draft = ''
  }

  // Cmd/Ctrl+Enter sends, matching the agent composer.
  function onComposerKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void submitComment()
  }

  function openInBrowser(url: string): void {
    void window.workbench.openExternal(url)
  }
</script>

{#if github.detailLoading && !detail}
  <p class="px-4 py-6 text-xs text-dim">Loading…</p>
{:else if github.detailError}
  <p class="px-4 py-6 text-xs text-red">{github.detailError}</p>
{:else if !detail}
  <p class="px-4 py-6 text-xs text-dim">Select an issue or pull request.</p>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-line px-4 py-3">
      <div class="flex items-start gap-2">
        <h2 class="min-w-0 flex-1 text-sm font-semibold text-default">{detail.title}</h2>
        <button
          class="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover"
          onclick={() => openInBrowser(detail.url)}
        >
          Open on GitHub
        </button>
      </div>

      <div class="mt-1 flex flex-wrap items-center gap-2 text-2xs text-dim">
        <span class="font-mono">#{detail.number}</span>
        <span>{detail.state.toLowerCase()}</span>
        <span>by {detail.author}</span>
        <span>opened {ageLabel(detail.createdAt)}</span>
        {#if detail.kind === 'pull'}
          <span class="font-mono">{detail.headRefName} → {detail.baseRefName}</span>
          <GithubBadge tone="green">+{detail.additions}</GithubBadge>
          <GithubBadge tone="red">−{detail.deletions}</GithubBadge>
          {#if reviewLabel(detail.reviewDecision)}
            <GithubBadge tone={reviewTone(detail.reviewDecision)}>
              {reviewLabel(detail.reviewDecision)}
            </GithubBadge>
          {/if}
        {/if}
      </div>

      {#if detail.labels.length > 0}
        <div class="mt-2 flex flex-wrap gap-1">
          {#each detail.labels as label (label.name)}
            <span
              class="rounded-full px-1.5 text-2xs"
              class:text-white={labelIsDark(label.color)}
              class:text-black={!labelIsDark(label.color)}
              style:background-color="#{label.color}"
            >
              {label.name}
            </span>
          {/each}
        </div>
      {/if}

      {#if actions.length > 0}
        <div class="mt-3 flex gap-2">
          {#each actions as action (action)}
            <button
              class="rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover disabled:opacity-50"
              disabled={github.busy}
              onclick={() => runAction(action)}
            >
              {actionLabels[action]}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <FloatingScrollbar class="min-h-0 flex-1">
      <div class="px-4 py-3">
        {#if detail.body.trim().length > 0}
          <div class="agent-markdown prose max-w-none text-xs text-default">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderMarkdown(detail.body)}
          </div>
        {:else}
          <p class="text-xs text-dim">No description.</p>
        {/if}

        {#each detail.comments as comment (comment.id)}
          <div class="mt-4 border-t border-line pt-3">
            <div class="mb-1 flex items-center gap-2 text-2xs text-dim">
              <span class="text-default">{comment.author}</span>
              <span>{ageLabel(comment.createdAt)}</span>
              {#if comment.reviewState}
                <GithubBadge tone={reviewTone(comment.reviewState)}>
                  {comment.reviewState.toLowerCase().replace('_', ' ')}
                </GithubBadge>
              {/if}
            </div>
            <div class="agent-markdown prose max-w-none text-xs text-default">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html renderMarkdown(comment.body)}
            </div>
          </div>
        {/each}
      </div>
    </FloatingScrollbar>

    <div class="border-t border-line p-3">
      <textarea
        class="h-20 w-full resize-none rounded-md border border-line bg-input px-2 py-1.5 text-xs text-default outline-none placeholder:text-dim focus:border-line-strong"
        placeholder="Comment on #{detail.number} — ⌘/Ctrl+Enter to send"
        bind:value={draft}
        onkeydown={onComposerKey}
      ></textarea>
      <div class="mt-2 flex justify-end">
        <button
          class="rounded-md bg-action px-3 py-1 text-2xs text-action-fg hover:bg-action-hover disabled:opacity-50"
          disabled={github.busy || draft.trim().length === 0}
          onclick={submitComment}
        >
          Comment
        </button>
      </div>
    </div>
  </div>
{/if}
