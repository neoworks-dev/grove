// Turning a raw GitHub timeline into the rows the thread draws.
//
// The only real work here is folding label changes together. GitHub emits one
// event per label, so applying three labels in one edit produces three rows
// saying the same thing about the same moment; the website shows a single
// "added a, b and c". Runs by the same actor, close in time, collapse into one
// row that keeps the labels in the order they were applied.

import type { GithubActor, GithubLabel, GithubTimelineEntry } from '../../../../../shared/types'

/**
 * How far apart two label events can be and still read as one edit. Long enough
 * to cover a slow multi-label save, short enough that relabelling an issue a day
 * later is its own row.
 */
const LABEL_FOLD_WINDOW_MS = 60_000

export type TimelineRow =
  | { kind: 'comment'; id: string; entry: Extract<GithubTimelineEntry, { type: 'comment' }> }
  | { kind: 'event'; id: string; entry: Extract<GithubTimelineEntry, { type: 'event' }> }
  | {
      kind: 'labels'
      id: string
      actor: GithubActor
      at: string
      added: GithubLabel[]
      removed: GithubLabel[]
    }

/** Whether an entry is a labelling by this actor within the folding window. */
function joinsLabelRun(entry: GithubTimelineEntry, row: TimelineRow): boolean {
  if (row.kind !== 'labels') return false
  if (entry.type !== 'event') return false
  if (entry.event.kind !== 'labeled' && entry.event.kind !== 'unlabeled') return false
  if (entry.event.actor.login !== row.actor.login) return false
  const gap = Date.parse(entry.at) - Date.parse(row.at)
  return Number.isFinite(gap) && Math.abs(gap) <= LABEL_FOLD_WINDOW_MS
}

/** Add a labelling to the run it continues. */
function extendLabelRun(
  row: Extract<TimelineRow, { kind: 'labels' }>,
  label: GithubLabel,
  added: boolean
): void {
  const target = added ? row.added : row.removed
  if (target.some((entry) => entry.name === label.name)) return
  target.push(label)
}

/**
 * The rows for a thread, in time order, with consecutive label changes folded
 * into one row each.
 */
export function foldTimeline(entries: GithubTimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const entry of entries) {
    const previous = rows[rows.length - 1]
    const isLabelling =
      entry.type === 'event' && (entry.event.kind === 'labeled' || entry.event.kind === 'unlabeled')

    if (!isLabelling) {
      rows.push(plainRow(entry))
      continue
    }
    // Narrowed by isLabelling, which TypeScript cannot carry across the branch.
    const event = (entry as Extract<GithubTimelineEntry, { type: 'event' }>).event
    if (!event.label) continue

    if (previous && joinsLabelRun(entry, previous) && previous.kind === 'labels') {
      extendLabelRun(previous, event.label, event.kind === 'labeled')
      continue
    }
    rows.push({
      kind: 'labels',
      id: event.id,
      actor: event.actor,
      at: entry.at,
      added: event.kind === 'labeled' ? [event.label] : [],
      removed: event.kind === 'unlabeled' ? [event.label] : []
    })
  }
  return rows
}

/** A comment or a non-label event, as its own row. */
function plainRow(entry: GithubTimelineEntry): TimelineRow {
  if (entry.type === 'comment') return { kind: 'comment', id: entry.comment.id, entry }
  return { kind: 'event', id: entry.event.id, entry }
}

/** How an author's relationship to the repository reads beside their name. */
export function associationLabel(association: string): string | null {
  if (association === 'OWNER') return 'Owner'
  if (association === 'MEMBER') return 'Member'
  if (association === 'COLLABORATOR') return 'Collaborator'
  if (association === 'CONTRIBUTOR') return 'Contributor'
  return null
}
