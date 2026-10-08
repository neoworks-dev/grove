// Saved views of the issue list: a name for a search query together with how
// its issues are laid out and grouped, kept per repository so "my urgent bugs
// as a list" is one click away. Which view is on is not stored: the tab whose
// view matches what the pane shows is the one lit, so changing the filter by
// hand leaves every tab dark until it is saved again.

/** How a view lays its issues out. */
export type IssueLayout = 'list' | 'board' | 'calendar'

/** One saved view. */
export interface SavedView {
  id: string
  name: string
  /** The search query, in GitHub's syntax. */
  query: string
  layout: IssueLayout
  /** The issue field the issues are grouped or placed by; null for an ungrouped list. */
  fieldId: string | null
}

/** What the pane is showing, in the terms a view is saved in. */
export type ViewState = Omit<SavedView, 'id' | 'name'>

const KEY_PREFIX = 'grove.github.views:'

/** The views saved for a repository, oldest first; none when there are none or they cannot be read. */
export function loadViews(repoPath: string): SavedView[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY_PREFIX + repoPath)
  } catch {
    return []
  }
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as SavedView[]
  } catch {
    return []
  }
}

/** Stores a repository's views; storage that refuses only costs keeping them. */
export function storeViews(repoPath: string, views: SavedView[]): void {
  try {
    localStorage.setItem(KEY_PREFIX + repoPath, JSON.stringify(views))
  } catch {
    // Quota or private mode: the views last until the window closes.
  }
}

/** A new view of the given state, under a name trimmed of surrounding space. */
export function createView(name: string, state: ViewState): SavedView {
  return { id: newViewId(), name: name.trim(), ...state }
}

/** An id no other view has, unique enough for a list a person keeps by hand. */
function newViewId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Whether a view is what the pane shows. The query is compared without the
 * spacing a hand-typed one varies in, and the field only where the layout uses
 * one: a board or calendar always does, a list only when it is grouped.
 */
export function viewMatches(view: ViewState, state: ViewState): boolean {
  if (normaliseQuery(view.query) !== normaliseQuery(state.query)) return false
  if (view.layout !== state.layout) return false
  return view.fieldId === state.fieldId
}

/** A query with its whitespace folded, so `is:open  label:bug` and `is:open label:bug` agree. */
function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ')
}
