<script lang="ts">
  // The Files half of a pull request: what it changes, as the directory tree it
  // changed them in. A flat list of paths says nothing about where in the
  // repository the work landed, and truncates the end of a long path — the part
  // being looked for — to fit the pane.
  //
  // Opening a file checks the pull request out as a worktree first, so what you
  // read is the real tree at that revision — every file, not only the changed
  // ones — with the changed file opened beside the merge base's copy of it.
  //
  // Ticking a file off is GitHub's own viewed state and a comment goes onto
  // GitHub's own pending review, so a review carries between here and the Files
  // tab on github.com rather than being two reviews.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import GithubBadge from './GithubBadge.svelte'
  import GithubPrFileRow from './GithubPrFileRow.svelte'
  import { buildPrFileTree } from './prFileTree'
  import { revealPrLine } from './prReview'
  import {
    checkoutPr,
    discardPrReview,
    github,
    isPrFileRejected,
    isPrFileViewed,
    loadPrDiff,
    loadPrReview,
    loadPrViewedFiles,
    markPrFileViewed,
    openPrFile,
    prThreadsFor,
    submitPrReview
  } from './store.svelte'
  import type {
    GithubItemDetail,
    GithubPrFile,
    GithubReviewEvent,
    GithubReviewThread
  } from '../../../../../shared/types'

  let { detail }: { detail: GithubItemDetail } = $props()

  const diff = $derived(github.prDiffs[detail.number])
  const tree = $derived(diff ? buildPrFileTree(diff.files) : [])
  let openPath = $state<string | null>(null)

  // Directories are open unless the user folded one, so the changed files are
  // all in view the moment the tab is. Comments start folded: the count is the
  // thing worth seeing at a glance, the bodies are not.
  let collapsed = $state<Record<string, boolean>>({})
  let expanded = $state<Record<string, boolean>>({})

  let submitting = $state(false)
  let summary = $state('')

  const viewedCount = $derived(
    diff ? diff.files.filter((file) => isPrFileViewed(detail.number, file.path)).length : 0
  )

  const review = $derived(github.prReviews[detail.number])
  const draftCount = $derived(
    review ? review.threads.filter((thread) => thread.pending).length : 0
  )

  // Fetched when the tab is first looked at rather than when the item is
  // selected: the first load pulls the pull request into the repository, which
  // is the slow part of all of this.
  $effect(() => {
    if (!detail.baseRefName) return
    void loadPrDiff(detail.number, detail.baseRefName)
  })

  // Its own effect: loadPrDiff reads the cached diff, so sharing one would
  // re-run this every time a diff landed and ask GitHub twice per open.
  $effect(() => {
    void loadPrViewedFiles(detail.number)
  })

  $effect(() => {
    void loadPrReview(detail.number)
  })

  function toggle(path: string): void {
    collapsed = { ...collapsed, [path]: !collapsed[path] }
  }

  function toggleComments(path: string): void {
    expanded = { ...expanded, [path]: !expanded[path] }
  }

  function viewedAt(path: string): boolean {
    return isPrFileViewed(detail.number, path)
  }

  function rejectedAt(path: string): boolean {
    return isPrFileRejected(detail.number, path)
  }

  function threadsAt(path: string): GithubReviewThread[] {
    return prThreadsFor(detail.number, path)
  }

  async function openFile(file: GithubPrFile): Promise<void> {
    openPath = file.path
    await openPrFile(detail, file)
  }

  /**
   * Go to a comment: its file, and then the line it is on in the half of the
   * diff it was left on. A comment about the whole file has no line to go to,
   * so opening the file is the whole of it.
   */
  async function openThread(thread: GithubReviewThread): Promise<void> {
    const file = diff ? diff.files.find((entry) => entry.path === thread.path) : undefined
    if (!file) return
    await openFile(file)
    if (thread.line === null) return
    await revealPrLine(thread.side, thread.line)
  }

  async function discard(): Promise<void> {
    const gone = await discardPrReview(detail)
    if (!gone) return
    summary = ''
    submitting = false
  }

  async function submit(event: GithubReviewEvent): Promise<void> {
    const sent = await submitPrReview(detail, event, summary)
    if (!sent) return
    summary = ''
    submitting = false
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex items-center gap-2 border-b border-line px-4 py-1.5 text-2xs text-dim">
    <span>
      {#if diff && viewedCount > 0}
        {viewedCount} of {diff.files.length} reviewed
      {:else}
        {diff ? diff.files.length : (detail.changedFiles ?? 0)} files
      {/if}
    </span>
    {#if draftCount > 0}
      <GithubBadge tone="blue" title="Written but not submitted">
        {draftCount} draft{draftCount === 1 ? '' : 's'}
      </GithubBadge>
    {/if}
    <button
      class="ml-auto rounded border border-line px-2 py-0.5 hover:bg-hover hover:text-default disabled:opacity-50"
      disabled={github.busy || !detail.baseRefName}
      title="Create a worktree on this pull request's head and select it"
      onclick={() => checkoutPr(detail)}
    >
      Check out
    </button>
    <button
      class="rounded border border-line px-2 py-0.5 hover:bg-hover hover:text-default"
      title="Send the comments you have written, with a verdict"
      onclick={() => (submitting = !submitting)}
    >
      Submit review
    </button>
  </div>

  {#if submitting}
    <div class="border-b border-line px-4 py-2">
      <textarea
        class="w-full resize-y rounded border border-line bg-input px-2 py-1 text-2xs text-default outline-none"
        rows="3"
        placeholder="Anything to say about the pull request as a whole (optional)"
        bind:value={summary}
      ></textarea>
      <div class="mt-1.5 flex items-center gap-1.5 text-2xs">
        <span class="flex-1 text-dim">
          {#if draftCount > 0}
            {draftCount} comment{draftCount === 1 ? '' : 's'} go with it
          {:else}
            No comments written yet
          {/if}
        </span>
        <button
          class="rounded border border-line px-2 py-0.5 text-green hover:bg-hover disabled:opacity-50"
          disabled={github.prReviewBusy}
          onclick={() => void submit('APPROVE')}
        >
          Approve
        </button>
        <button
          class="rounded border border-line px-2 py-0.5 text-red hover:bg-hover disabled:opacity-50"
          disabled={github.prReviewBusy}
          onclick={() => void submit('REQUEST_CHANGES')}
        >
          Request changes
        </button>
        <button
          class="rounded border border-line px-2 py-0.5 text-muted hover:bg-hover disabled:opacity-50"
          disabled={github.prReviewBusy}
          onclick={() => void submit('COMMENT')}
        >
          Comment
        </button>
        <button
          class="rounded px-2 py-0.5 text-dim hover:bg-hover hover:text-red disabled:opacity-50"
          disabled={github.prReviewBusy || draftCount === 0}
          title="Throw away the comments you have written"
          onclick={() => void discard()}
        >
          Discard
        </button>
      </div>
    </div>
  {/if}

  <FloatingScrollbar class="min-h-0 flex-1">
    <div class="flex flex-col py-1">
      {#if github.prDiffLoading && !diff}
        <p class="px-4 py-6 text-xs text-dim">Fetching the pull request…</p>
      {:else if !diff}
        <p class="px-4 py-6 text-xs text-dim">No changed files.</p>
      {:else}
        {#each tree as node (node.path)}
          <GithubPrFileRow
            {node}
            {collapsed}
            {expanded}
            {openPath}
            isViewed={viewedAt}
            isRejected={rejectedAt}
            threadsOf={threadsAt}
            onToggle={toggle}
            onToggleComments={toggleComments}
            onOpen={openFile}
            onOpenThread={openThread}
            onToggleViewed={(file, viewed) => markPrFileViewed(detail, file, viewed)}
          />
        {/each}
      {/if}
    </div>
  </FloatingScrollbar>
</div>
