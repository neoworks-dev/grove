<script lang="ts">
  // The open item, laid out the way GitHub lays one out: a state pill under the
  // title, the body as the first card of a timeline, then every comment and
  // event down a rail, with the item's metadata beside it when there is room.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import { github, postComment, runAction } from './store.svelte'
  import GithubBadge from './GithubBadge.svelte'
  import GithubCommentCard from './GithubCommentCard.svelte'
  import GithubEventRow from './GithubEventRow.svelte'
  import GithubEventIcon from './GithubEventIcon.svelte'
  import GithubTimelineRow from './GithubTimelineRow.svelte'
  import GithubSidebar from './GithubSidebar.svelte'
  import GithubMentionBox from './GithubMentionBox.svelte'
  import GithubPrFiles from './GithubPrFiles.svelte'
  import GithubPrConflicts from './GithubPrConflicts.svelte'
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon'
  import XCircleIcon from 'phosphor-svelte/lib/XCircleIcon'
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon'
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon'
  import EyeIcon from 'phosphor-svelte/lib/EyeIcon'
  import { dialogs } from '../../../lib/dialogs.svelte'
  import { ageLabel, availableActions, reviewLabel, reviewTone, stateTone } from './filter'
  import { foldTimeline } from './timeline'
  import type { GithubThreadTab } from './store.svelte'
  import type { GithubItemAction } from '../../../../../shared/types'

  // Below this the metadata moves above the timeline instead of beside it.
  const SIDEBAR_PX = 620

  // Prose does not get more readable past a point, it gets harder — a comment
  // run across a 1400px monitor is a line the eye loses its place in. The
  // timeline caps here and the composer matches it, so the two stay aligned;
  // the metadata rail sits outside the cap rather than eating into it.
  const READING_PX = 800
  const SIDEBAR_WIDTH_PX = 208
  const COLUMN_GAP_PX = 16

  const contentWidth = $derived.by<string>(() => {
    if (!wide) return `${READING_PX}px`
    return `${READING_PX + COLUMN_GAP_PX + SIDEBAR_WIDTH_PX}px`
  })

  let draft = $state('')
  let width = $state(0)
  let composerFocused = $state(false)

  // Stays open while there is something in it, so clicking away to re-read the
  // thread does not fold a half-written comment out of sight.
  const composerOpen = $derived(composerFocused || draft.trim().length > 0)

  const detail = $derived(github.detail)
  const wide = $derived(width > 0 && width >= SIDEBAR_PX)

  const threadTabs: Array<{ id: GithubThreadTab; label: string }> = [
    { id: 'conversation', label: 'Conversation' },
    { id: 'files', label: 'Files' }
  ]

  // Only a pull request has a second half; the tab is remembered across items, so
  // an issue opened after one still shows its conversation.
  const showFiles = $derived(detail?.kind === 'pull' && github.threadTab === 'files')
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

  /**
   * Closing is one click next to the comment box and reopening is a round trip
   * through GitHub, so it asks first. Merging asks in the store already, and
   * the rest are cheap to undo.
   */
  async function confirmAction(action: GithubItemAction): Promise<void> {
    if (action !== 'close' || !detail) {
      await runAction(action)
      return
    }
    const picked = await dialogs.confirm({
      title: `Close #${detail.number}?`,
      body: detail.title,
      actions: [
        { id: 'close', label: 'Close', kind: 'danger' },
        { id: 'cancel', label: 'Cancel' }
      ]
    })
    if (picked !== 'close') return
    await runAction(action)
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
    <!-- One row: what it is, then what can be done to it. The state, the author
         and the diff size share the second line, which is all the chrome a
         thread needs before its own content starts. -->
    <div class="border-b border-line px-4 py-2">
      <div class="flex items-center gap-2">
        <span
          class="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium text-white"
          class:bg-green={stateTone(detail) === 'green'}
          class:bg-red={stateTone(detail) === 'red'}
          class:bg-violet={stateTone(detail) === 'violet'}
          class:bg-dim={stateTone(detail) === 'dim'}
        >
          {detail.state.toLowerCase()}
        </span>
        <h2 class="min-w-0 flex-1 truncate text-xs font-semibold text-default" title={detail.title}>
          {detail.title}
          <span class="font-mono font-normal text-dim">#{detail.number}</span>
        </h2>

        {#each actions as action (action)}
          <button
            class="shrink-0 rounded p-1 text-dim hover:bg-hover hover:text-default disabled:opacity-50"
            disabled={github.busy}
            title={actionLabels[action]}
            aria-label={actionLabels[action]}
            onclick={() => confirmAction(action)}
          >
            {#if action === 'close'}
              <XCircleIcon size={14} />
            {:else if action === 'reopen'}
              <ArrowCounterClockwiseIcon size={14} />
            {:else if action === 'merge'}
              <GitMergeIcon size={14} />
            {:else}
              <EyeIcon size={14} />
            {/if}
          </button>
        {/each}

        <button
          class="shrink-0 rounded p-1 text-dim hover:bg-hover hover:text-default"
          title="Open on GitHub"
          aria-label="Open on GitHub"
          onclick={() => openInBrowser(detail.url)}
        >
          <ArrowSquareOutIcon size={14} />
        </button>
      </div>

      <div class="mt-1 flex flex-wrap items-center gap-2 text-2xs text-dim">
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

      <GithubPrConflicts {detail} />

      <!-- A pull request has two halves; an issue has one, so it gets no tabs. -->
      {#if detail.kind === 'pull'}
        <div class="mt-2 flex gap-3 text-2xs">
          {#each threadTabs as tab (tab.id)}
            <button
              class="border-b-2 pb-1 hover:text-default"
              class:border-action={github.threadTab === tab.id}
              class:text-default={github.threadTab === tab.id}
              class:border-transparent={github.threadTab !== tab.id}
              class:text-dim={github.threadTab !== tab.id}
              onclick={() => (github.threadTab = tab.id)}
            >
              {tab.label}
              {#if tab.id === 'files' && detail.changedFiles}
                <span class="font-mono text-dim">{detail.changedFiles}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if showFiles}
      <GithubPrFiles {detail} />
    {:else}
      <FloatingScrollbar class="min-h-0 flex-1">
        <div
          class="mx-auto flex w-full gap-4 px-4 py-3"
          class:flex-col={!wide}
          style:max-width={contentWidth}
        >
          <!-- Everything hangs off one rail, the opening body included, so the
             thread reads as a single sequence rather than stacked blocks. -->
          <div class="flex min-w-0 flex-1 flex-col" style:max-width="{READING_PX}px">
            <GithubTimelineRow last={rows.length === 0}>
              <GithubCommentCard
                author={detail.authorActor}
                association={detail.authorAssociation}
                body={detail.body}
                at={detail.createdAt}
                verb="opened"
              />
            </GithubTimelineRow>

            {#each rows as row, index (row.id)}
              <GithubTimelineRow last={index === rows.length - 1}>
                {#snippet icon()}
                  <GithubEventIcon {row} />
                {/snippet}
                {#if row.kind === 'comment'}
                  <GithubCommentCard
                    author={row.entry.comment.author}
                    association={row.entry.comment.authorAssociation}
                    body={row.entry.comment.body}
                    at={row.entry.comment.createdAt}
                    reviewState={row.entry.comment.reviewState}
                  />
                {:else}
                  <GithubEventRow {row} />
                {/if}
              </GithubTimelineRow>
            {/each}
          </div>

          <aside class="shrink-0" class:w-52={wide}>
            <GithubSidebar {detail} />
          </aside>
        </div>
      </FloatingScrollbar>

      <!-- Collapsed to a line until it is being used: an empty comment box was
         taking a fifth of the pane away from the thread it belongs to. -->
      <div class="border-t border-line px-3 py-2">
        <div class="mx-auto w-full" style:max-width="{READING_PX}px">
          <GithubMentionBox
            bind:value={draft}
            rows={composerOpen ? 5 : 1}
            chrome={composerOpen}
            disabled={github.busy}
            placeholder="Comment on #{detail.number} — @ to mention, ⌘/Ctrl+Enter to send"
            onfocus={() => (composerFocused = true)}
            onblur={() => (composerFocused = false)}
            onsubmit={submitComment}
          />
          {#if composerOpen}
            <div class="mt-2 flex justify-end">
              <button
                class="rounded-md bg-action px-3 py-1 text-2xs text-action-fg hover:opacity-90 disabled:opacity-50"
                disabled={github.busy || draft.trim().length === 0}
                onclick={submitComment}
              >
                {github.busy ? 'Sending…' : 'Comment'}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
