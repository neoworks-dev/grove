// State behind the GitHub pane: the fetched dashboard, the selected item and
// its thread, and the polling that keeps both fresh.
//
// Fetches are serialized per surface (one list request, one detail request at a
// time) and detail responses carry a token, so a slow reply for an item the user
// has already navigated away from is dropped instead of overwriting the view.

import { dialogs } from '../../../lib/dialogs.svelte'
import { authorsOf, filterItems, projectsOf, typesOf } from './filter'
import type {
  GithubActor,
  GithubCapabilities,
  GithubDashboard,
  GithubMilestone,
  GithubIssueDraft,
  GithubItem,
  GithubCloseReason,
  GithubItemAction,
  GithubItemDetail,
  GithubItemKind,
  GithubLabelDefinition,
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

class GithubStore {
  status = $state<GithubStatus | null>(null)
  dashboard = $state<GithubDashboard | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)

  tab = $state<GithubItemKind>('pull')
  stateFilter = $state<GithubStateFilter>('open')
  query = $state('')
  /** Logins picked in the Author menu; empty means every author. */
  authorFilter = $state<string[]>([])
  /** Label names picked in the Labels menu; an item must carry all of them. */
  labelFilter = $state<string[]>([])
  /** Milestone titles picked in the Milestone menu; any one of them matches. */
  milestoneFilter = $state<string[]>([])
  /** Issue type names picked in the Type menu; any one of them matches. */
  typeFilter = $state<string[]>([])
  /** Project titles picked in the Projects menu; any one of them matches. */
  projectFilter = $state<string[]>([])

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

  /** The active tab's items, after the search box and the filter menus. */
  get items(): GithubItem[] {
    return filterItems(this.tabItems, {
      query: this.query,
      authors: this.authorFilter,
      labels: this.labelFilter,
      milestones: this.milestoneFilter,
      types: this.typeFilter,
      projects: this.projectFilter
    })
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
    if (!this.dashboard) return { projects: false, issueTypes: false }
    return this.dashboard.capabilities
  }

  /** Whether anything is narrowing the list beyond the state filter. */
  get filtersActive(): boolean {
    return (
      this.authorFilter.length > 0 ||
      this.labelFilter.length > 0 ||
      this.milestoneFilter.length > 0 ||
      this.typeFilter.length > 0 ||
      this.projectFilter.length > 0
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
  if (!options.silent) github.loading = true
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

/** Drop every narrowing the menus applied. */
export function clearFilters(): void {
  github.authorFilter = []
  github.labelFilter = []
  github.milestoneFilter = []
  github.typeFilter = []
  github.projectFilter = []
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
  if (github.labels.length > 0) return
  try {
    github.labels = await window.workbench.github.labels()
  } catch (err) {
    dialogs.notify({ level: 'error', message: `Could not load labels: ${(err as Error).message}` })
  }
}

/**
 * Load the repository's milestones once. A failure leaves the picker empty and
 * says so there, rather than taking down the rail it sits in.
 */
export async function loadMilestones(): Promise<void> {
  if (github.milestones.length > 0) return
  try {
    github.milestones = await window.workbench.github.milestones()
  } catch (err) {
    dialogs.notify({
      level: 'error',
      message: `Could not load milestones: ${(err as Error).message}`
    })
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
  if (github.mentionables.length > 0) return
  try {
    github.mentionables = await window.workbench.github.mentionables()
  } catch {
    github.mentionables = []
  }
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
