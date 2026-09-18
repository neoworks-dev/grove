// State behind the GitHub pane: the fetched dashboard, the selected item and
// its thread, and the polling that keeps both fresh.
//
// Fetches are serialized per surface (one list request, one detail request at a
// time) and detail responses carry a token, so a slow reply for an item the user
// has already navigated away from is dropped instead of overwriting the view.

import { dialogs } from '../../../lib/dialogs.svelte'
import { filterItems } from './filter'
import type {
  GithubDashboard,
  GithubItem,
  GithubItemAction,
  GithubItemDetail,
  GithubItemKind,
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

  selection = $state<GithubSelection | null>(null)
  detail = $state<GithubItemDetail | null>(null)
  detailLoading = $state(false)
  detailError = $state<string | null>(null)

  /** A comment is being posted, or an action is running. */
  busy = $state(false)

  /** The active tab's items, after the search box. */
  get items(): GithubItem[] {
    if (!this.dashboard) return []
    const source: GithubItem[] =
      this.tab === 'pull' ? this.dashboard.pulls : this.dashboard.issues
    return filterItems(source, this.query)
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

/** Select an item and load its body and comments. */
export async function selectItem(selection: GithubSelection | null): Promise<void> {
  github.selection = selection
  github.detail = null
  github.detailError = null
  if (!selection) return
  await loadDetail(selection, { silent: false })
}

/** (Re)load the open item's thread. */
async function loadDetail(
  selection: GithubSelection,
  options: { silent: boolean }
): Promise<void> {
  githubInternals.detailToken += 1
  const token = githubInternals.detailToken
  if (!options.silent) github.detailLoading = true
  try {
    const detail = await window.workbench.github.item(selection.kind, selection.number)
    if (token !== githubInternals.detailToken) return
    github.detail = detail
    github.detailError = null
  } catch (err) {
    if (token !== githubInternals.detailToken) return
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
