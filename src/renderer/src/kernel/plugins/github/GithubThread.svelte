<script lang="ts">
  // The open item, laid out the way GitHub lays one out: a state pill under the
  // title, the body as the first card of a timeline, then every comment and
  // event down a rail, with the item's metadata beside it when there is room.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { github, postComment, runAction } from './store.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubCommentCard from './GithubCommentCard.svelte'
  import GithubEventRow from './GithubEventRow.svelte'
  import GithubSidebar from './GithubSidebar.svelte'
  import GithubMentionBox from './GithubMentionBox.svelte'
  import { ageLabel, availableActions, reviewLabel, reviewTone, stateTone } from './filter'
  import { foldTimeline } from './timeline'
  import type { GithubItemAction } from '../../../../../shared/types'

  // Below this the metadata moves above the timeline instead of beside it.
  const SIDEBAR_PX = 620

  let draft = $state('')
  let width = $state(0)

  const detail = $derived(github.detail)
  const wide = $derived(width > 0 && width >= SIDEBAR_PX)
  const rows = $derived.by(() => {
    if (!detail) return []
    return foldTimeline(detail.timeline)
  })

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

  function openInBrowser(url: string): void {
    void window.workbench.openExternal(url)
  }
</script>

<div class="flex h-full min-h-0 flex-col" bind:clientWidth={width}>
  {#if github.detailLoading && !detail}
    <p class="px-4 py-6 text-xs text-dim">Loading…</p>
  {:else if github.detailError && !detail}
    <p class="px-4 py-6 text-xs text-red">{github.detailError}</p>
  {:else if !detail}
    <p class="px-4 py-6 text-xs text-dim">Select an issue or pull request.</p>
  {:else}
    <div class="border-b border-line px-4 py-3">
      <div class="flex items-start gap-2">
        <h2 class="min-w-0 flex-1 text-sm font-semibold text-default">
          {detail.title}
          <span class="font-mono font-normal text-dim">#{detail.number}</span>
        </h2>
        <button
          class="shrink-0 rounded-md border border-line px-2 py-1 text-2xs text-dim hover:bg-hover"
          onclick={() => openInBrowser(detail.url)}
        >
          Open on GitHub
        </button>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2 text-2xs text-dim">
        <span
          class="rounded-full px-2 py-0.5 font-medium text-white"
          class:bg-green={stateTone(detail) === 'green'}
          class:bg-red={stateTone(detail) === 'red'}
          class:bg-violet={stateTone(detail) === 'violet'}
          class:bg-dim={stateTone(detail) === 'dim'}
        >
          {detail.state.toLowerCase()}
        </span>
        <span>{detail.authorActor.login} opened {ageLabel(detail.createdAt)}</span>
        {#if detail.kind === 'pull'}
          <GithubBadge tone="green">+{detail.additions}</GithubBadge>
          <GithubBadge tone="red">−{detail.deletions}</GithubBadge>
          {#if reviewLabel(detail.reviewDecision)}
            <GithubBadge tone={reviewTone(detail.reviewDecision)}>
              {reviewLabel(detail.reviewDecision)}
            </GithubBadge>
          {/if}
        {/if}
      </div>

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
      <div class="flex gap-4 px-4 py-3" class:flex-col={!wide}>
        <div class="min-w-0 flex-1">
          <GithubCommentCard
            author={detail.authorActor}
            association={detail.authorAssociation}
            body={detail.body}
            at={detail.createdAt}
            verb="opened"
          />

          <!-- The rail: events sit on the line, comments hang off it as cards. -->
          <div class="ml-2.5 border-l border-line pl-4">
            {#each rows as row (row.id)}
              {#if row.kind === 'comment'}
                <div class="py-2">
                  <GithubCommentCard
                    author={row.entry.comment.author}
                    association={row.entry.comment.authorAssociation}
                    body={row.entry.comment.body}
                    at={row.entry.comment.createdAt}
                    reviewState={row.entry.comment.reviewState}
                  />
                </div>
              {:else}
                <GithubEventRow {row} />
              {/if}
            {/each}
          </div>
        </div>

        <aside class="shrink-0" class:w-52={wide}>
          <GithubSidebar {detail} />
        </aside>
      </div>
    </FloatingScrollbar>

    <div class="border-t border-line p-3">
      <GithubMentionBox
        bind:value={draft}
        rows={3}
        disabled={github.busy}
        placeholder="Comment on #{detail.number} — @ to mention, ⌘/Ctrl+Enter to send"
        onsubmit={submitComment}
      />
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
  {/if}
</div>
