<script lang="ts">
  // The commit graph: every branch's history as lanes, labelled with the
  // branches, remote branches and tags on each commit, for the selected
  // worktree's repository. History loads a page at a time as it is scrolled,
  // and only the rows on screen are rendered, so a long history costs what a
  // short one does. Selecting a commit shows it beside the graph; the row's
  // menu acts on it, and a label's menu on its branch or tag.
  import FloatingScrollbar from '@neoworks-dev/ui/FloatingScrollbar'
  import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon'
  import CloudArrowDownIcon from 'phosphor-svelte/lib/CloudArrowDownIcon'
  import { untrack } from 'svelte'
  import ContextMenu, { type MenuItem } from '../../../components/ContextMenu.svelte'
  import RowAction from '../gitChanges/RowAction.svelte'
  import CommitDetails from './CommitDetails.svelte'
  import GraphCell, { graphWidth, laneColour } from './GraphCell.svelte'
  import RefChip from './RefChip.svelte'
  import { store } from '../../../lib/store.svelte'
  import { layout } from '../../../lib/layout.svelte'
  import { relativeTime } from '../../../lib/time'
  import { layoutGraph } from './graphLayout'
  import { labelsBySha } from './refLabels'
  import { compareRefs } from '../gitChanges/compareTarget.svelte'
  import { copyText, rebaseCurrentOnto } from '../gitChanges/refActions'
  import type { RefMenuContext } from '../gitChanges/refMenus'
  import {
    checkoutCommit,
    cherryPickCommit,
    resetToCommit,
    revertCommit
  } from './commitActions'
  import type { CommitSummary, RefList, ResetMode } from '../../../../../shared/types'

  const ROW_HEIGHT = 24
  const PAGE_SIZE = 200
  // Rows rendered beyond each edge of the viewport, so a quick scroll does not
  // show blank space before the next frame.
  const OVERSCAN = 12
  // A graph wider than this is cut off on the right rather than squeezing the
  // messages; its leftmost lanes are the long-lived ones.
  const MAX_GRAPH_WIDTH = 180
  // Wide enough for the column's heading however few lanes there are.
  const MIN_GRAPH_WIDTH = 48
  // Changes on disk arrive in bursts; the graph reloads once they settle.
  const RELOAD_DELAY_MS = 300
  // How many more pages selecting an unloaded parent will read to find it.
  const SEEK_PAGES = 10

  let commits = $state<CommitSummary[]>([])
  let head = $state<string | null>(null)
  let hasMore = $state(false)
  let refs = $state<RefList>({ local: [], remote: [], tags: [] })
  let selectedSha = $state<string | null>(null)
  let branchFormOpen = $state(false)
  let loadingMore = $state(false)
  let fetching = $state(false)
  let viewport = $state<HTMLDivElement>()
  let scrollTop = $state(0)
  let viewportHeight = $state(0)
  let menu = $state<{ x: number; y: number; commit: CommitSummary } | null>(null)
  let loadedWorktreeId: string | null = null

  const worktreeId = $derived(store.selectedWorktreeId)
  const worktree = $derived(store.selectedWorktree)
  const currentBranch = $derived.by(() => {
    const current = refs.local.find((branch) => branch.current)
    if (current) return current.name
    return ''
  })
  const graph = $derived(layoutGraph(commits))
  const labels = $derived(labelsBySha(refs, head))
  const fullGraphWidth = $derived(graphWidth(graph.columns))
  const graphColumnWidth = $derived(
    Math.min(Math.max(fullGraphWidth, MIN_GRAPH_WIDTH), MAX_GRAPH_WIDTH)
  )
  const firstVisible = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN))
  const lastVisible = $derived(
    Math.min(commits.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  )
  const visibleIndexes = $derived(
    Array.from({ length: Math.max(0, lastVisible - firstVisible) }, (_, offset) => firstVisible + offset)
  )
  const selected = $derived(commits.find((commit) => commit.sha === selectedSha))
  const menuContext = $derived<RefMenuContext>({
    worktreeId: worktreeId ?? '',
    worktreePath: worktree?.path ?? '',
    currentBranch,
    onChanged: () => void load()
  })

  /** Re-reads the refs and as much history as was already loaded. */
  async function load(): Promise<void> {
    const id = store.selectedWorktreeId
    if (!id) return
    const switched = id !== loadedWorktreeId
    let shown = PAGE_SIZE
    if (!switched) shown = untrack(() => Math.max(PAGE_SIZE, commits.length))
    try {
      const [page, refList] = await Promise.all([
        window.workbench.git.graph(id, 0, shown),
        window.workbench.git.refs(id)
      ])
      if (id !== store.selectedWorktreeId) return
      commits = page.commits
      head = page.head
      hasMore = page.hasMore
      refs = refList
      loadedWorktreeId = id
      if (switched) resetView()
    } catch (err) {
      store.setError((err as Error).message)
    }
  }

  /** Back to the top with nothing selected, for a freshly opened repository. */
  function resetView(): void {
    selectedSha = null
    branchFormOpen = false
    if (viewport) viewport.scrollTop = 0
  }

  /** Appends the next page of history. */
  async function loadMore(): Promise<void> {
    const id = store.selectedWorktreeId
    if (!id || loadingMore || !hasMore) return
    loadingMore = true
    try {
      const page = await window.workbench.git.graph(id, commits.length, PAGE_SIZE)
      if (id !== store.selectedWorktreeId) return
      commits = [...commits, ...page.commits]
      hasMore = page.hasMore
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      loadingMore = false
    }
  }

  /** Tracks the scroll position, and reads more history on nearing the end. */
  function onScroll(): void {
    if (!viewport) return
    scrollTop = viewport.scrollTop
    const remaining = commits.length * ROW_HEIGHT - (scrollTop + viewportHeight)
    if (remaining < OVERSCAN * ROW_HEIGHT) void loadMore()
  }

  /** Selects a commit and brings its row into view, reading further back if it is not loaded yet. */
  async function selectSha(sha: string): Promise<void> {
    let pages = 0
    while (indexOf(sha) === -1 && hasMore && pages < SEEK_PAGES) {
      await loadMore()
      pages += 1
    }
    const index = indexOf(sha)
    if (index === -1) return
    select(sha)
    scrollToIndex(index)
  }

  /** Makes a commit the selected one. */
  function select(sha: string): void {
    if (sha !== selectedSha) branchFormOpen = false
    selectedSha = sha
  }

  /** The row index of a commit, or -1 when it is not loaded. */
  function indexOf(sha: string): number {
    return commits.findIndex((commit) => commit.sha === sha)
  }

  /** Scrolls just enough to show a row. */
  function scrollToIndex(index: number): void {
    if (!viewport) return
    const top = index * ROW_HEIGHT
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewportHeight) {
      viewport.scrollTop = top + ROW_HEIGHT - viewportHeight
    }
  }

  /** Arrow keys walk the selection; Escape clears it. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      selectedSha = null
      return
    }
    let step = 0
    if (event.key === 'ArrowDown') step = 1
    if (event.key === 'ArrowUp') step = -1
    if (step === 0 || commits.length === 0) return
    event.preventDefault()
    let index = 0
    if (selectedSha !== null) index = Math.max(0, indexOf(selectedSha) + step)
    index = Math.min(index, commits.length - 1)
    select(commits[index].sha)
    scrollToIndex(index)
    if (index > commits.length - OVERSCAN) void loadMore()
  }

  /** Fetches every remote, then reloads. */
  async function fetchRemotes(): Promise<void> {
    if (!worktreeId) return
    fetching = true
    try {
      await window.workbench.git.fetch(worktreeId)
      await load()
    } catch (err) {
      store.setError((err as Error).message)
    } finally {
      fetching = false
    }
  }

  /** Opens a commit's menu at the pointer, selecting it. */
  function openMenu(event: MouseEvent, commit: CommitSummary): void {
    event.preventDefault()
    select(commit.sha)
    menu = { x: event.clientX, y: event.clientY, commit }
  }

  /** Runs a commit action and reloads when it changed anything. */
  async function run(action: () => Promise<boolean>): Promise<void> {
    if (await action()) await load()
  }

  /** Points the source-control view's compare section at a commit. */
  function compareWith(commit: CommitSummary, head: string | null): void {
    layout.ensurePane('changes')
    compareRefs(commit.sha, head)
  }

  /** Everything a commit's menu offers. Moving the branch needs one checked out. */
  function commitMenu(commit: CommitSummary): MenuItem[] {
    const id = worktreeId
    if (!id) return []
    const items: MenuItem[] = [
      { label: 'Checkout (detached)', action: () => void run(() => checkoutCommit(id, commit)) },
      { label: 'Create branch here…', action: () => openBranchForm(commit) },
      { divider: true },
      { label: 'Cherry-pick', action: () => void run(() => cherryPickCommit(id, commit)) },
      { label: 'Revert…', action: () => void run(() => revertCommit(id, commit)) }
    ]
    if (currentBranch.length > 0) items.push(...branchMovingItems(id, commit))
    items.push(
      { divider: true },
      { label: 'Compare with HEAD', action: () => compareWith(commit, 'HEAD') },
      { label: 'Compare with working tree', action: () => compareWith(commit, null) },
      { divider: true },
      { label: 'Copy SHA', action: () => copyText(commit.sha) },
      { label: 'Copy message', action: () => copyText(commit.subject) }
    )
    return items
  }

  /** The menu items that move the checked-out branch: rebasing and resetting. */
  function branchMovingItems(id: string, commit: CommitSummary): MenuItem[] {
    const reset = (mode: ResetMode): MenuItem => ({
      label: `Reset ${currentBranch} here (${mode})…`,
      danger: mode === 'hard',
      action: () => void run(() => resetToCommit(id, currentBranch, commit, mode))
    })
    return [
      { divider: true },
      {
        label: `Rebase ${currentBranch} onto this…`,
        action: () => void run(() => rebaseCurrentOnto(id, currentBranch, commit.sha))
      },
      reset('soft'),
      reset('mixed'),
      reset('hard')
    ]
  }

  /** Selects a commit with the create-branch form open. */
  function openBranchForm(commit: CommitSummary): void {
    select(commit.sha)
    branchFormOpen = true
  }

  /** Who, when and which commit, for a row's tooltip. */
  function details(commit: CommitSummary): string {
    const date = new Date(commit.date).toLocaleString()
    return `${commit.shortSha} · ${commit.authorName} · ${date}\n\n${commit.subject}`
  }

  // Reload when the worktree, its branch or anything on disk changes — once
  // things settle, not on every event of a burst.
  $effect(() => {
    void store.selectedWorktreeId
    void store.selectedWorktree?.branch
    void store.fsVersion[store.selectedWorktreeId ?? '']
    const timer = setTimeout(() => void load(), RELOAD_DELAY_MS)
    return () => clearTimeout(timer)
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-canvas text-xs">
  <div class="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
    <span class="text-muted">Commit Graph</span>
    {#if currentBranch}
      <span class="truncate text-dim">{currentBranch}</span>
    {:else if head}
      <span class="text-dim">detached at {head.slice(0, 7)}</span>
    {/if}
    <span class="flex-1"></span>
    <RowAction
      icon={CloudArrowDownIcon}
      title="Fetch"
      disabled={fetching}
      onclick={fetchRemotes}
    />
    <RowAction icon={ArrowClockwiseIcon} title="Refresh" onclick={() => void load()} />
  </div>

  <div class="flex min-h-0 flex-1">
    <div class="@container flex min-w-0 flex-1 flex-col">
      <div
        class="flex h-6 shrink-0 items-center gap-2 border-b border-line-faint pr-2 text-2xs text-dim"
      >
        <span class="shrink-0 pl-2" style:width="{graphColumnWidth}px">Graph</span>
        <span class="min-w-0 flex-1">Commit</span>
        <span class="hidden w-32 shrink-0 @2xl:block">Author</span>
        <span class="hidden w-20 shrink-0 @lg:block">Date</span>
        <span class="hidden w-14 shrink-0 @md:block">SHA</span>
      </div>

      <div class="min-h-0 flex-1" bind:clientHeight={viewportHeight}>
        <FloatingScrollbar class="h-full" bind:viewport onscroll={onScroll}>
          <div
            class="relative outline-none"
            style:height="{commits.length * ROW_HEIGHT}px"
            role="grid"
            tabindex="0"
            aria-label="Commit graph"
            onkeydown={onKeydown}
          >
            {#each visibleIndexes as index (commits[index].sha)}
              {@const commit = commits[index]}
              {@const row = graph.rows[index]}
              <div
                class={[
                  'absolute inset-x-0 flex cursor-default items-center gap-2 pr-2 select-none',
                  { 'bg-raised': commit.sha === selectedSha, 'hover:bg-hover': commit.sha !== selectedSha }
                ]}
                style:top="{index * ROW_HEIGHT}px"
                style:height="{ROW_HEIGHT}px"
                role="row"
                tabindex="-1"
                aria-selected={commit.sha === selectedSha}
                aria-label={commit.subject}
                title={details(commit)}
                onclick={() => select(commit.sha)}
                oncontextmenu={(event) => openMenu(event, commit)}
              >
                <div class="shrink-0 overflow-hidden" style:width="{graphColumnWidth}px">
                  <GraphCell
                    {row}
                    width={fullGraphWidth}
                    height={ROW_HEIGHT}
                    merge={commit.parents.length > 1}
                    head={commit.sha === head}
                  />
                </div>
                <div class="flex min-w-0 flex-1 items-center gap-1">
                  {#each labels.get(commit.sha) ?? [] as label (label.kind + label.name)}
                    <RefChip {label} context={menuContext} colour={laneColour(row.colour)} />
                  {/each}
                  <span
                    class="truncate"
                    class:text-default={commit.sha === head}
                    class:text-muted={commit.sha !== head}
                  >
                    {commit.subject}
                  </span>
                </div>
                <span class="hidden w-32 shrink-0 truncate text-dim @2xl:block">
                  {commit.authorName}
                </span>
                <span class="hidden w-20 shrink-0 truncate text-dim @lg:block">
                  {relativeTime(commit.date)}
                </span>
                <span class="hidden w-14 shrink-0 font-mono text-2xs text-dim @md:block">
                  {commit.shortSha}
                </span>
              </div>
            {/each}
          </div>
          {#if commits.length === 0}
            <p class="px-3 py-2 text-dim">No commits yet.</p>
          {/if}
        </FloatingScrollbar>
      </div>
    </div>

    {#if selected && worktreeId}
      <div class="w-80 shrink-0 border-l border-line">
        <CommitDetails
          {worktreeId}
          commit={selected}
          bind:branchFormOpen
          onSelectSha={(sha) => void selectSha(sha)}
          onChanged={() => void load()}
          onClose={() => (selectedSha = null)}
        />
      </div>
    {/if}
  </div>
</div>

{#if menu}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    items={commitMenu(menu.commit)}
    onClose={() => (menu = null)}
  />
{/if}
