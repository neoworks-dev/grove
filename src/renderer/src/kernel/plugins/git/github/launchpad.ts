// Launchpad's groups: every pull request and issue sorted by what it needs,
// the way GitKraken's Launchpad does it. Pinned items come first, then the pull
// requests, then the issues. A pinned item also stays in its own group, so the
// group still says what state it is in.

import type { GithubIssueItem, GithubItem, GithubPullItem } from '../../../../../../shared/types'

export type LaunchpadGroupId =
  | 'pinned'
  | 'needs-your-review'
  | 'ci-failing'
  | 'changes-requested'
  | 'ready-to-merge'
  | 'waiting-on-others'
  | 'draft'
  | 'merged'
  | 'closed-pulls'
  | 'assigned-to-you'
  | 'unassigned'
  | 'assigned-to-others'
  | 'closed-issues'

export interface LaunchpadGroup {
  /** One of the groups above, or an issue field option's name when issues are grouped by a field. */
  id: string
  title: string
  items: GithubItem[]
  /** GitHub's colour name for a field option; absent for Launchpad's own groups. */
  colour?: string
}

// The order the groups are shown in. Empty groups are left out.
const PULL_GROUPS: { id: LaunchpadGroupId; title: string }[] = [
  { id: 'needs-your-review', title: 'Needs your review' },
  { id: 'ci-failing', title: 'CI failing' },
  { id: 'changes-requested', title: 'Changes requested' },
  { id: 'ready-to-merge', title: 'Ready to merge' },
  { id: 'waiting-on-others', title: 'Waiting on others' },
  { id: 'draft', title: 'Draft' },
  { id: 'merged', title: 'Merged' },
  { id: 'closed-pulls', title: 'Closed pull requests' }
]

const ISSUE_GROUPS: { id: LaunchpadGroupId; title: string }[] = [
  { id: 'assigned-to-you', title: 'Assigned to you' },
  { id: 'unassigned', title: 'Unassigned' },
  { id: 'assigned-to-others', title: 'Assigned to others' },
  { id: 'closed-issues', title: 'Closed issues' }
]

// Check rollups that mean a check broke, rather than is still running.
const FAILED_CHECKS = ['FAILURE', 'ERROR']

/** The key a pin is stored under. Issues and pull requests share one number sequence, but the kind keeps it readable. */
export function pinKey(item: Pick<GithubItem, 'kind' | 'number'>): string {
  return `${item.kind}:${item.number}`
}

/** Whether an item is pinned, here or on GitHub's own issue list. */
export function isPinned(item: GithubItem, pins: ReadonlySet<string>): boolean {
  if (pins.has(pinKey(item))) return true
  return item.isPinned === true
}

/** Which group a pull request belongs in, by what it is waiting for. */
export function pullGroupOf(pull: GithubPullItem, viewer: string | null): LaunchpadGroupId {
  if (pull.state === 'MERGED') return 'merged'
  if (pull.state !== 'OPEN') return 'closed-pulls'
  if (pull.isDraft) return 'draft'
  if (viewer && pull.reviewRequested && pull.reviewRequested.includes(viewer)) {
    return 'needs-your-review'
  }
  if (pull.checks && FAILED_CHECKS.includes(pull.checks)) return 'ci-failing'
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested'
  if (readyToMerge(pull)) return 'ready-to-merge'
  return 'waiting-on-others'
}

/** Approved, or needing no review, with checks passed or none to run. */
function readyToMerge(pull: GithubPullItem): boolean {
  if (pull.reviewDecision === 'REVIEW_REQUIRED') return false
  if (pull.checks === null) return true
  return pull.checks === 'SUCCESS'
}

/** Which group an issue belongs in, by who has it. */
export function issueGroupOf(issue: GithubIssueItem, viewer: string | null): LaunchpadGroupId {
  if (issue.state !== 'OPEN') return 'closed-issues'
  if (issue.assignees.length === 0) return 'unassigned'
  const assignedToViewer = issue.assignees.some((assignee) => assignee.login === viewer)
  if (assignedToViewer) return 'assigned-to-you'
  return 'assigned-to-others'
}

/**
 * Sorts items into Launchpad's groups: pinned first, then pull requests, then
 * issues. `groupIssues` replaces the issues' own groups, for a list grouped by
 * an issue field.
 */
export function launchpadGroups(
  items: GithubItem[],
  viewer: string | null,
  pins: ReadonlySet<string>,
  groupIssues?: (issues: GithubIssueItem[]) => LaunchpadGroup[]
): LaunchpadGroup[] {
  const pinned = items.filter((item) => isPinned(item, pins))
  const pullsSorted = sortByGroup(
    items.filter((item): item is GithubPullItem => item.kind === 'pull'),
    (pull) => pullGroupOf(pull, viewer)
  )
  const issues = items.filter((item): item is GithubIssueItem => item.kind === 'issue')

  const groups: LaunchpadGroup[] = []
  if (pinned.length > 0) groups.push({ id: 'pinned', title: 'Pinned', items: pinned })
  appendGroups(groups, PULL_GROUPS, pullsSorted)
  if (groupIssues) {
    groups.push(...groupIssues(issues))
    return groups
  }
  appendGroups(
    groups,
    ISSUE_GROUPS,
    sortByGroup(issues, (issue) => issueGroupOf(issue, viewer))
  )
  return groups
}

/** Buckets items by the group each one falls in, keeping their order. */
function sortByGroup<T extends GithubItem>(
  items: T[],
  groupOf: (item: T) => LaunchpadGroupId
): Map<LaunchpadGroupId, GithubItem[]> {
  const buckets = new Map<LaunchpadGroupId, GithubItem[]>()
  for (const item of items) {
    const id = groupOf(item)
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = []
      buckets.set(id, bucket)
    }
    bucket.push(item)
  }
  return buckets
}

/** Adds the groups that have items, in the order given. */
function appendGroups(
  groups: LaunchpadGroup[],
  order: { id: LaunchpadGroupId; title: string }[],
  buckets: Map<LaunchpadGroupId, GithubItem[]>
): void {
  for (const group of order) {
    const items = buckets.get(group.id)
    if (!items) continue
    groups.push({ id: group.id, title: group.title, items })
  }
}

// Pins are this machine's, kept per repository beside the saved views.
const PINS_KEY_PREFIX = 'grove.github.pins:'

/** The items pinned in a repository, as pin keys. */
export function loadPins(repoPath: string): string[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PINS_KEY_PREFIX + repoPath)
  } catch {
    return []
  }
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((key): key is string => typeof key === 'string')
  } catch {
    return []
  }
}

/** Writes a repository's pins back. */
export function storePins(repoPath: string, pins: string[]): void {
  try {
    localStorage.setItem(PINS_KEY_PREFIX + repoPath, JSON.stringify(pins))
  } catch {
    // Quota or private mode: the pins last until the window closes.
  }
}
