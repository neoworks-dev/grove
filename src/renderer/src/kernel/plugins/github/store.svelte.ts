// State behind the GitHub pane: the fetched dashboard, the selected item and
// its thread, and the polling that keeps both fresh.
//
// Fetches are serialized per surface (one list request, one detail request at a
// time) and detail responses carry a token, so a slow reply for an item the user
// has already navigated away from is dropped instead of overwriting the view.

import { dialogs } from '../../../lib/dialogs.svelte'
import type { DialogOptions } from '../../../lib/dialogs.svelte'
import {
  store,
  openFileInEditor,
  refreshWorktrees,
  selectWorktree
} from '../../../lib/store.svelte'
import { layout } from '../../../lib/layout.svelte'
import { branchNameFor } from './branches'
import { diffAgainstBase, showPrBaseOnly } from './prDiff'
import { clearRefusals, loadOnce, newReferenceLoads } from './referenceLoads'
import { authorsOf, projectsOf, typesOf } from './filter'
import {
  DEFAULT_QUERY,
  filterItems,
  parseSearch,
  stateFilterFor,
  stringifySearch,
  toggleQualifier,
  valuesOf
} from './search'
import type { QualifierKey, SearchQuery } from './search'
import type {
  GithubActor,
  GithubCapabilities,
  GithubDashboard,
  GithubMilestone,
  GithubIssueDraft,
  GithubItem,
  GithubCloseReason,
  GithubItemAction,
  GithubItemCommand,
  GithubItemDetail,
  GithubItemKind,
  GithubLabelDefinition,
  GithubPrDiff,
  GithubPrFile,
  GithubStateFilter,
  GithubStatus,
  MergePrOptions
} from '../../../../../shared/types'

/** How many items each side of the dashboard asks for. */
const PAGE_SIZE = 50

/** Poll interval. Matches gh-dash's default refetch cadence. */
const REFRESH_INTERVAL_MS = 60_000

export interface GithubSelection {
  kind: GithubItemKind
  number: number
}

/** The two halves of a pull request's thread, as GitHub names them. */
export type GithubThreadTab = 'conversation' | 'files'

class GithubStore {
  status = $state<GithubStatus | null>(null)
  dashboard = $state<GithubDashboard | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)

  tab = $state<GithubItemKind>('pull')

  /**
   * The whole filter, in GitHub's own syntax. The menus write into this and
   * read their ticks back out of it, so there is exactly one place a narrowing
   * is written down and nothing on screen can disagree with the box.
   */
  query = $state(DEFAULT_QUERY)

  selection = $state<GithubSelection | null>(null)
  detail = $state<GithubItemDetail | null>(null)
  detailLoading = $state(false)
  detailError = $state<string | null>(null)

  /** A comment is being posted, or an action is running. */
  busy = $state(false)

  /** The new-issue composer is open. */
  composing = $state(false)
  /**
   * What the composer holds. It lives here rather than in the component so
   * closing the composer — or opening a thread over it — does not throw away a
   * half-written issue.
   */
  draft = $state<GithubIssueDraft>({ title: '', body: '', labels: [] })
  /** The repository's own labels, for the pickers. Loaded on demand. */
  labels = $state<GithubLabelDefinition[]>([])
  /** The repository's own milestones, for the sidebar picker. On demand too. */
  milestones = $state<GithubMilestone[]>([])

  /**
   * Threads already fetched this session, keyed `kind:number`. Reselecting an
   * item shows its thread at once and refreshes behind it, instead of blanking
   * the pane and refetching what was on screen a moment ago.
   */
  details = $state<Record<string, GithubItemDetail>>({})

  /** People the repository can assign, for @mention completion. */
  mentionables = $state<GithubActor[]>([])

  /**
   * Which half of a pull request's thread is showing. Issues have no Files tab,
   * so this is only read for pull requests — but it is held per pane rather than
   * per item, the way GitHub does it, so walking a list of pull requests stays
   * on Files once you have gone there.
   */
  threadTab = $state<GithubThreadTab>('conversation')

  /**
   * Changed-file lists already fetched, keyed by pull-request number. The first
   * load fetches the pull request into the local object store, which is the slow
   * part; everything after it is read from there.
   */
  prDiffs = $state<Record<number, GithubPrDiff>>({})
  prDiffLoading = $state(false)

  /**
   * Paths this viewer has marked as read, per pull request. GitHub's own
   * record, so it is the same tick as the Files tab on github.com — a review
   * started in the browser continues here and the other way round.
   */
  prViewedFiles = $state<Record<number, string[]>>({})

  /**
   * Numbers ticked in the list, for acting on several at once. Held per tab,
   * because a pull request and an issue with the same number are different
   * things and the actions that apply to them differ.
   */
  checked = $state<number[]>([])

  /** Everyone already on the open thread — offered ahead of the repository. */
  get threadActors(): GithubActor[] {
    const detail = this.detail
    if (!detail) return []
    const collected: GithubActor[] = [detail.authorActor]
    for (const entry of detail.timeline) {
      if (entry.type === 'comment') {
        collected.push(entry.comment.author)
        continue
      }
      collected.push(entry.event.actor)
    }
    return collected
  }

  /**
   * Everyone who has said or done something on the open thread, once each —
   * GitHub's Participants, which the timeline already knows and so costs no
   * extra selection. The deleted-account placeholder is not a participant.
   */
  get participants(): GithubActor[] {
    const collected: GithubActor[] = []
    for (const actor of this.threadActors) {
      if (actor.login === 'ghost') continue
      if (collected.some((entry) => entry.login === actor.login)) continue
      collected.push(actor)
    }
    return collected
  }

  /** The query as qualifiers, which everything below reads rather than the string. */
  search: SearchQuery = $derived(parseSearch(this.query))

  /**
   * Which states the fetch has to cover. Read off `is:` rather than held beside
   * it, so the dropdown and the query cannot disagree about what is on screen.
   *
   * Derived rather than a getter on purpose: the refresh effect watches this,
   * and a getter would make it depend on the query string itself — one fetch
   * per keystroke, when only `is:` can actually change what has to be fetched.
   */
  stateFilter: GithubStateFilter = $derived(stateFilterFor(this.search))

  /** The active tab's items, after the whole query. */
  get items(): GithubItem[] {
    return filterItems(this.tabItems, this.search, this.viewer)
  }

  /** The authenticated user, for `@me`. */
  get viewer(): string | null {
    if (!this.dashboard) return null
    return this.dashboard.viewer
  }

  /** The active tab before any narrowing — what the menus offer options from. */
  get tabItems(): GithubItem[] {
    if (!this.dashboard) return []
    if (this.tab === 'pull') return this.dashboard.pulls
    return this.dashboard.issues
  }

  /** Every author on this tab, for the Author menu. */
  get authorOptions(): string[] {
    return authorsOf(this.tabItems)
  }

  /** Every issue type on this tab, for the Type menu. */
  get typeOptions(): string[] {
    return typesOf(this.tabItems)
  }

  /** Every project board on this tab, for the Projects menu. */
  get projectOptions(): string[] {
    return projectsOf(this.tabItems)
  }

  /**
   * What this token was allowed to ask GitHub for. Absent until the first load,
   * which reads as "not available" — the menus appear once the answer is in
   * rather than flickering on and off.
   */
  get capabilities(): GithubCapabilities {
    if (!this.dashboard) {
      return { projects: false, issueTypes: false, subIssues: false, linkedBranches: false }
    }
    return this.dashboard.capabilities
  }

  /** Whether anything is narrowing the list beyond the state the fetch covers. */
  get filtersActive(): boolean {
    const search = this.search
    if (search.text.length > 0) return true
    return search.qualifiers.some(
      (qualifier) => qualifier.key !== 'is' && qualifier.key !== 'state'
    )
  }

  get counts(): { pull: number; issue: number } {
    if (!this.dashboard) return { pull: 0, issue: 0 }
    return { pull: this.dashboard.pulls.length, issue: this.dashboard.issues.length }
  }
}

export const github = new GithubStore()

// Bookkeeping that must not be reactive: the in-flight guard for the list, and
// the token that lets a stale detail response be discarded.
const githubInternals = {
  listInFlight: false,
  detailToken: 0
}

// The labels, milestones and assignable people the menus need. Several
// components want each of them and want it the moment they mount, so they are
// loaded through one place that knows what is already in flight and what has
// already been refused — see referenceLoads.ts for why neither can be worked
// out from the loaded list itself.
const referenceLoads = newReferenceLoads()

/** Load a piece of reference data once, reporting a failure to the user. */
function loadReference(key: string, load: () => Promise<void>): Promise<void> {
  return loadOnce(referenceLoads, key, load, (error) => {
    dialogs.notify({ level: 'error', message: error.message })
  })
}

/**
 * Load the list for a state filter. The filter is a parameter rather than a
 * store read so a caller inside an effect depends on it. `silent` keeps the
 * spinner off for background polls, so the pane does not flicker every minute.
 */
export async function refreshDashboard(
  state: GithubStateFilter,
  options: { silent?: boolean } = {}
): Promise<void> {
  if (githubInternals.listInFlight) return
  githubInternals.listInFlight = true
  // A refresh the user asked for is also them asking to try again; a background
  // poll is not, and retrying on the poll is what this guards against.
  if (!options.silent) {
    github.loading = true
    clearRefusals(referenceLoads)
  }
  try {
    const status = await window.workbench.github.status()
    github.status = status
    if (!status.repo) {
      github.dashboard = null
      github.error = status.error
      return
    }
    github.dashboard = await window.workbench.github.dashboard({ state, limit: PAGE_SIZE })
    github.error = null
  } catch (err) {
    github.error = (err as Error).message
  } finally {
    github.loading = false
    githubInternals.listInFlight = false
  }
}

/** The cache key for a thread. */
function detailKey(selection: GithubSelection): string {
  return `${selection.kind}:${selection.number}`
}

/**
 * Select an item and show its thread. A thread already read this session is put
 * up immediately and refreshed silently; only a first visit shows the spinner.
 */
export async function selectItem(selection: GithubSelection | null): Promise<void> {
  github.selection = selection
  github.detailError = null
  if (!selection) {
    github.detail = null
    return
  }
  const cached = github.details[detailKey(selection)]
  if (cached) {
    github.detail = cached
    await loadDetail(selection, { silent: true })
    return
  }
  github.detail = null
  await loadDetail(selection, { silent: false })
}

/**
 * Put a qualifier in the query, or take it out when it is already there. Every
 * filter menu goes through here, which is why picking one from a menu and
 * typing it by hand end in the same query.
 */
export function toggleFilter(key: QualifierKey, value: string): void {
  github.query = toggleQualifier(github.query, key, value)
}

/** What a menu ticks: the values the query already names under its key. */
export function filterValues(key: QualifierKey): string[] {
  return valuesOf(github.search, key)
}

/**
 * Drop every narrowing but the state, which is what the dropdown beside this
 * owns — clearing the filters should not silently widen the fetch.
 */
export function clearFilters(): void {
  const search = github.search
  github.query = stringifySearch({
    text: '',
    qualifiers: search.qualifiers.filter(
      (qualifier) => qualifier.key === 'is' || qualifier.key === 'state'
    )
  })
}

/** Tick or untick one row. */
export function toggleChecked(number: number): void {
  if (github.checked.includes(number)) {
    github.checked = github.checked.filter((entry) => entry !== number)
    return
  }
  github.checked = [...github.checked, number]
}

/** Tick every row the filter is currently showing, or clear them all. */
export function checkAllVisible(checkedState: boolean): void {
  if (!checkedState) {
    github.checked = []
    return
  }
  github.checked = github.items.map((item) => item.number)
}

/**
 * Run one action across every ticked row, then reload once. Failures are
 * collected rather than thrown one at a time — half a bulk edit going through
 * is worth reporting as a whole.
 */
export async function runBulkAction(
  action: GithubItemAction,
  reason?: GithubCloseReason
): Promise<void> {
  const numbers = [...github.checked]
  if (numbers.length === 0) return
  const kind = github.tab
  github.busy = true
  const failed: number[] = []
  try {
    for (const number of numbers) {
      try {
        await window.workbench.github.action(kind, number, action, undefined, reason)
      } catch {
        failed.push(number)
      }
    }
  } finally {
    github.busy = false
  }
  reportBulkOutcome(ACTION_TITLES[action], numbers.length, failed)
  github.checked = []
  await refreshDashboard(github.stateFilter, { silent: true })
}

/** Assign people to every ticked row. */
export async function assignChecked(logins: string[]): Promise<void> {
  const numbers = [...github.checked]
  if (numbers.length === 0 || logins.length === 0) return
  const kind = github.tab
  github.busy = true
  const failed: number[] = []
  try {
    for (const number of numbers) {
      try {
        await window.workbench.github.changeAssignees(kind, number, { add: logins, remove: [] })
      } catch {
        failed.push(number)
      }
    }
  } finally {
    github.busy = false
  }
  reportBulkOutcome('Assigned', numbers.length, failed)
  await refreshDashboard(github.stateFilter, { silent: true })
}

/** Change who is assigned on the open item. */
export async function applyAssignees(next: string[]): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return
  const add = next.filter((login) => !detail.assignees.includes(login))
  const remove = detail.assignees.filter((login) => !next.includes(login))
  if (add.length === 0 && remove.length === 0) return
  github.busy = true
  try {
    await window.workbench.github.changeAssignees(selection.kind, selection.number, { add, remove })
    await loadDetail(selection, { silent: true })
    void refreshDashboard(github.stateFilter, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/** Add labels to every ticked row. */
export async function addLabelsToChecked(labels: string[]): Promise<void> {
  const numbers = [...github.checked]
  if (numbers.length === 0 || labels.length === 0) return
  const kind = github.tab
  github.busy = true
  const failed: number[] = []
  try {
    for (const number of numbers) {
      try {
        await window.workbench.github.changeLabels(kind, number, { add: labels, remove: [] })
      } catch {
        failed.push(number)
      }
    }
  } finally {
    github.busy = false
  }
  reportBulkOutcome('Labelled', numbers.length, failed)
  await refreshDashboard(github.stateFilter, { silent: true })
}

/** One notification for a whole bulk run, naming what did not go through. */
function reportBulkOutcome(verb: string, total: number, failed: number[]): void {
  if (failed.length === 0) {
    dialogs.notify({ level: 'info', message: `${verb} ${total} item${total === 1 ? '' : 's'}` })
    return
  }
  const names = failed.map((number) => `#${number}`).join(', ')
  dialogs.notify({
    level: 'error',
    message: `${verb} ${total - failed.length} of ${total}. Failed: ${names}`
  })
}

/**
 * Follow a reference from one item to another. The tab has to move with it —
 * opening a pull request while the issue list is showing would leave the thread
 * and the list disagreeing about what is selected.
 */
export async function openReference(kind: GithubItemKind, number: number): Promise<void> {
  github.composing = false
  github.tab = kind
  await selectItem({ kind, number })
}

/** (Re)load the open item's thread. */
async function loadDetail(selection: GithubSelection, options: { silent: boolean }): Promise<void> {
  githubInternals.detailToken += 1
  const token = githubInternals.detailToken
  if (!options.silent) github.detailLoading = true
  try {
    const detail = await window.workbench.github.item(selection.kind, selection.number)
    if (token !== githubInternals.detailToken) return
    github.details = { ...github.details, [detailKey(selection)]: detail }
    github.detail = detail
    github.detailError = null
  } catch (err) {
    if (token !== githubInternals.detailToken) return
    // A background refresh that fails leaves the thread that is already on
    // screen alone; only a first load has nothing to fall back to.
    if (options.silent && github.detail) return
    github.detailError = (err as Error).message
  } finally {
    if (token === githubInternals.detailToken) github.detailLoading = false
  }
}

/**
 * Load a pull request's changed files once. The first call fetches the pull
 * request's head and base into the repository, which for a large repository is
 * seconds rather than milliseconds — so it runs on opening the Files tab and not
 * on selecting the item, and never twice for the same number.
 */
export async function loadPrDiff(number: number, baseRefName: string): Promise<void> {
  if (github.prDiffs[number]) return
  github.prDiffLoading = true
  try {
    await loadReference(`pr-diff:${number}`, async () => {
      const diff = await window.workbench.github.prDiff(number, baseRefName)
      github.prDiffs = { ...github.prDiffs, [number]: diff }
    })
  } finally {
    github.prDiffLoading = false
  }
}

/**
 * Load which of a pull request's files this viewer has already read. One round
 * trip for the whole pull request, beside the diff rather than part of it — the
 * diff comes from git, and keeping them apart is what lets a tick be re-read
 * without fetching the pull request again.
 */
export async function loadPrViewedFiles(number: number): Promise<void> {
  // Re-read every time the tab is opened rather than caching it with the diff:
  // the diff is cached because fetching the pull request is the slow part, and
  // a tick is the one thing here that changes while Grove is not looking.
  await loadReference(`pr-viewed:${number}`, async () => {
    const paths = await window.workbench.github.prViewedFiles(number)
    github.prViewedFiles = { ...github.prViewedFiles, [number]: paths }
  })
}

/** Whether this viewer has marked a path in this pull request as read. */
export function isPrFileViewed(number: number, path: string): boolean {
  const paths = github.prViewedFiles[number]
  if (!paths) return false
  return paths.includes(path)
}

/**
 * Tick a file as read, or take the tick off. The store moves first and is put
 * back if GitHub refuses: a checkbox that waits for a round trip before it
 * moves reads as a click that did not land.
 */
export async function setPrFileViewed(
  detail: GithubItemDetail,
  path: string,
  viewed: boolean
): Promise<void> {
  const before = github.prViewedFiles[detail.number] ?? []
  const after = viewed ? [...before, path] : before.filter((entry) => entry !== path)
  github.prViewedFiles = { ...github.prViewedFiles, [detail.number]: after }
  try {
    await window.workbench.github.setPrFileViewed(detail.id, path, viewed)
  } catch (err) {
    github.prViewedFiles = { ...github.prViewedFiles, [detail.number]: before }
    dialogs.notify({ level: 'error', message: (err as Error).message })
  }
}

/**
 * Check a pull request out as its own worktree and select it, so the whole tree
 * is there to read rather than the changed files alone. Existing worktrees are
 * reused — the branch is named after the pull request, so a second call finds
 * the first one's.
 */
export async function checkoutPr(detail: GithubItemDetail): Promise<string | null> {
  if (!detail.baseRefName) return null
  github.busy = true
  try {
    const worktree = await window.workbench.github.checkoutPr(detail.number, detail.baseRefName)
    // Selecting re-reads the worktree's services and diff stats, which is a
    // round trip per file opened if it is done unconditionally.
    if (store.selectedWorktreeId !== worktree.id) {
      await refreshWorktrees()
      await selectWorktree(worktree.id)
    }
    return worktree.id
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
    return null
  } finally {
    github.busy = false
  }
}

/**
 * Open one of a pull request's changed files: its worktree, then the file, then
 * the merge base's copy of it beside the file in Neovim's diff mode. The right
 * side is the real file in the real worktree, so it has its language server,
 * its git state and everything else the editor gives a file — the diff is a
 * second window onto it, not a copy of it.
 */
export async function openPrFile(detail: GithubItemDetail, file: GithubPrFile): Promise<void> {
  const diff = github.prDiffs[detail.number]
  if (!diff) return
  const worktreeId = await checkoutPr(detail)
  if (!worktreeId) return

  const worktree = store.worktrees.find((entry) => entry.id === worktreeId)
  if (!worktree) return

  // The editor is where both halves are read, and in the GitHub view it may not
  // be open at all.
  layout.ensurePane('nvim')

  // The file comes out of `prDiffs`, so it is a reactive proxy — and a proxy
  // cannot cross IPC ("An object could not be cloned"). Send the plain object.
  const base = await window.workbench.github.prBaseFile(diff.baseOid, $state.snapshot(file))
  // A deleted file has nothing to open beside the base copy, so the base copy is
  // the whole view.
  if (file.changeType === 'deleted') {
    await showPrBaseOnly(file, base)
    return
  }
  openFileInEditor(worktreeId, `${worktree.path}/${file.path}`)
  await diffAgainstBase(file, base)
}

/** Post a comment on the open item, then pull the thread back in. */
export async function postComment(body: string): Promise<boolean> {
  const selection = github.selection
  if (!selection) return false
  github.busy = true
  try {
    await window.workbench.github.comment(selection.kind, selection.number, body)
    await loadDetail(selection, { silent: true })
    void refreshDashboard(github.stateFilter, { silent: true })
    return true
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
    return false
  } finally {
    github.busy = false
  }
}

/**
 * Load the repository's labels once, so opening the composer a second time is
 * instant. A failure leaves the picker empty rather than blocking the compose —
 * an issue without labels still beats no issue.
 */
export async function loadLabels(): Promise<void> {
  await loadReference('labels', async () => {
    github.labels = await window.workbench.github.labels()
  })
}

/**
 * Load the repository's milestones once. A failure leaves the picker empty and
 * says so there, rather than taking down the rail it sits in.
 */
export async function loadMilestones(): Promise<void> {
  await loadReference('milestones', async () => {
    github.milestones = await window.workbench.github.milestones()
  })
}

/**
 * What each command needs said before it runs, or null when it needs nothing.
 * Pinning is reversible with the same click that did it; locking speaks for the
 * repository, transferring renumbers the issue somewhere else, and deleting is
 * gone for good — so those three name what is about to happen first.
 */
function commandConfirmation(
  command: GithubItemCommand,
  detail: GithubItemDetail
): DialogOptions | null {
  if (command === 'pin' || command === 'unpin' || command === 'unlock') return null
  if (command === 'lock') {
    return {
      title: `Lock the conversation on #${detail.number}?`,
      body: 'Only people with write access to the repository will be able to comment.',
      actions: [
        { id: 'go', label: 'Lock', kind: 'primary' },
        { id: 'cancel', label: 'Cancel' }
      ]
    }
  }
  return {
    title: `Delete #${detail.number}?`,
    body: `"${detail.title}" and its whole conversation go for good. This cannot be undone, here or on GitHub.`,
    actions: [
      { id: 'go', label: 'Delete', kind: 'danger' },
      { id: 'cancel', label: 'Cancel' }
    ]
  }
}

const COMMAND_OUTCOMES: Record<GithubItemCommand, string> = {
  lock: 'Locked',
  unlock: 'Unlocked',
  pin: 'Pinned',
  unpin: 'Unpinned',
  delete: 'Deleted'
}

/** Lock, unlock, pin, unpin or delete the open item. */
export async function runCommand(command: GithubItemCommand): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return

  const confirmation = commandConfirmation(command, detail)
  if (confirmation) {
    const picked = await dialogs.confirm(confirmation)
    if (picked !== 'go') return
  }

  github.busy = true
  try {
    await window.workbench.github.command(selection.kind, selection.number, command)
    dialogs.notify({
      level: 'info',
      message: `${COMMAND_OUTCOMES[command]} #${selection.number}`
    })
    // A deleted item has no thread left to reload, so the pane goes back to
    // the list rather than refreshing a 404.
    if (command === 'delete') {
      await selectItem(null)
    } else {
      await loadDetail(selection, { silent: true })
    }
    await refreshDashboard(github.stateFilter, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/**
 * Move the open issue to another repository. Its number there is a new one, so
 * the pane cannot keep showing it — it goes back to the list and says where the
 * issue went.
 */
export async function transferIssue(destination: string): Promise<boolean> {
  const detail = github.detail
  if (!detail) return false
  const picked = await dialogs.confirm({
    title: `Transfer #${detail.number} to ${destination}?`,
    body: `"${detail.title}" leaves this repository and is renumbered in ${destination}. Bringing it back is another transfer.`,
    actions: [
      { id: 'go', label: 'Transfer', kind: 'danger' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (picked !== 'go') return false

  github.busy = true
  try {
    const url = await window.workbench.github.transfer(detail.number, destination)
    dialogs.notify({ level: 'info', message: `Transferred to ${url}` })
    await selectItem(null)
    await refreshDashboard(github.stateFilter, { silent: true })
    return true
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
    return false
  } finally {
    github.busy = false
  }
}

/**
 * Open the composer on a copy of this issue. GitHub calls it Clone; there is no
 * gh command for it and there does not need to be — a clone is a new issue that
 * starts out saying the same thing, which the composer already knows how to do.
 */
export function cloneIssue(): void {
  const detail = github.detail
  if (!detail) return
  github.draft = {
    title: detail.title,
    body: detail.body,
    labels: detail.labels.map((label) => label.name)
  }
  github.composing = true
}

/** Whether the viewer is currently being notified about the open item. */
export function isSubscribed(detail: GithubItemDetail): boolean {
  return detail.viewerSubscription === 'SUBSCRIBED'
}

/** Start or stop being notified about the open item. */
export async function toggleSubscription(): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return
  github.busy = true
  try {
    await window.workbench.github.setSubscription(detail.id, !isSubscribed(detail))
    await loadDetail(selection, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/**
 * Open a worktree for the issue, on the branch the repository's own convention
 * names. This is the one thing in the rail that is Grove's rather than
 * GitHub's: the whole app is worktrees, and an issue is where one starts.
 */
export async function startWorkOnIssue(): Promise<void> {
  const detail = github.detail
  if (!detail) return
  const branch = branchNameFor(detail.number, detail.title)
  let baseBranch = 'main'
  const config = store.config
  if (config) baseBranch = config.workbench.default_base_branch

  const picked = await dialogs.confirm({
    title: `Open a worktree for #${detail.number}?`,
    body: `Branch ${branch}, cut from ${baseBranch}.`,
    actions: [
      { id: 'go', label: 'Create worktree', kind: 'primary' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (picked !== 'go') return

  github.busy = true
  try {
    const created = await window.workbench.worktrees.create({
      name: branch,
      baseBranch,
      newBranch: branch
    })
    await refreshWorktrees()
    await selectWorktree(created.id)
    dialogs.notify({ level: 'info', message: `Working on #${detail.number} in ${branch}` })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/** Put the open item on a milestone, or take it off one. */
export async function applyMilestone(title: string | null): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return
  const current = detail.milestone ? detail.milestone.title : null
  if (current === title) return
  github.busy = true
  try {
    await window.workbench.github.changeMilestone(selection.kind, selection.number, title)
    await loadDetail(selection, { silent: true })
    void refreshDashboard(github.stateFilter, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/**
 * Load the people a mention can name, once per session. A failure leaves
 * completion offering only the thread's own participants rather than breaking
 * the box it is attached to.
 */
export async function loadMentionables(): Promise<void> {
  await loadReference('mentionables', async () => {
    github.mentionables = await window.workbench.github.mentionables()
  })
}

/**
 * Create the composed issue, then show it: the draft is cleared, the list
 * reloads, the issue tab comes forward and the new issue opens, so the composer
 * ends on the thing it just made. The draft is kept when it fails, so the text
 * can be sent again.
 */
export async function createIssue(): Promise<boolean> {
  const draft = github.draft
  if (draft.title.trim().length === 0) return false
  github.busy = true
  try {
    const created = await window.workbench.github.createIssue({
      title: draft.title.trim(),
      body: draft.body,
      labels: draft.labels
    })
    github.draft = { title: '', body: '', labels: [] }
    github.composing = false
    dialogs.notify({ level: 'info', message: `Opened #${created.number}` })
    github.tab = 'issue'
    await refreshDashboard(github.stateFilter, { silent: true })
    await selectItem({ kind: 'issue', number: created.number })
    return true
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
    return false
  } finally {
    github.busy = false
  }
}

/**
 * Apply a new label set to the open item. The difference against what it
 * already carries is what gets sent, so an unchanged pick costs no call.
 */
export async function applyLabels(next: string[]): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return
  const current = detail.labels.map((label) => label.name)
  const add = next.filter((name) => !current.includes(name))
  const remove = current.filter((name) => !next.includes(name))
  if (add.length === 0 && remove.length === 0) return

  github.busy = true
  try {
    await window.workbench.github.changeLabels(selection.kind, selection.number, { add, remove })
    await loadDetail(selection, { silent: true })
    void refreshDashboard(github.stateFilter, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

const ACTION_TITLES: Record<GithubItemAction, string> = {
  close: 'Close',
  reopen: 'Reopen',
  ready: 'Mark ready for review',
  merge: 'Merge'
}

/**
 * Run a state-changing action. Merging is irreversible from here, so it asks
 * first and lets the user pick the merge method.
 */
export async function runAction(action: GithubItemAction): Promise<void> {
  const selection = github.selection
  const detail = github.detail
  if (!selection || !detail) return
  let merge: MergePrOptions | undefined
  if (action === 'merge') {
    const picked = await askMergeMethod(detail.number)
    if (!picked) return
    merge = picked
  }
  github.busy = true
  try {
    await window.workbench.github.action(selection.kind, selection.number, action, merge)
    dialogs.notify({
      level: 'info',
      message: `${ACTION_TITLES[action]}d #${selection.number}`
    })
    await loadDetail(selection, { silent: true })
    await refreshDashboard(github.stateFilter, { silent: true })
  } catch (err) {
    dialogs.notify({ level: 'error', message: (err as Error).message })
  } finally {
    github.busy = false
  }
}

/** Confirm a merge and collect its method; null when the user backs out. */
async function askMergeMethod(number: number): Promise<MergePrOptions | null> {
  const picked = await dialogs.confirm({
    title: `Merge pull request #${number}?`,
    body: 'This merges the pull request on GitHub. Pick how the commits should land.',
    actions: [
      { id: 'squash', label: 'Squash and merge', kind: 'primary' },
      { id: 'merge', label: 'Create a merge commit' },
      { id: 'rebase', label: 'Rebase and merge' },
      { id: 'cancel', label: 'Cancel' }
    ]
  })
  if (picked === 'cancel') return null
  return { method: picked as MergePrOptions['method'], deleteBranch: false }
}

/**
 * Keep the pane current: poll on an interval, and catch up immediately when the
 * window regains focus (the common case — the user was on github.com). Returns
 * the disposer, so the caller can stop polling when the pane goes away.
 */
export function startAutoRefresh(): () => void {
  const timer = setInterval(() => {
    if (document.hidden) return
    void pollAll()
  }, REFRESH_INTERVAL_MS)
  const onFocus = (): void => void pollAll()
  window.addEventListener('focus', onFocus)
  return () => {
    clearInterval(timer)
    window.removeEventListener('focus', onFocus)
  }
}

/** One background tick: the list, plus the open thread if there is one. */
async function pollAll(): Promise<void> {
  await refreshDashboard(github.stateFilter, { silent: true })
  const selection = github.selection
  if (selection) await loadDetail(selection, { silent: true })
}
