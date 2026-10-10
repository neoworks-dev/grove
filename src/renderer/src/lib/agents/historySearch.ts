/**
 * Reverse search over the prompts already sent, the way a shell's Ctrl+R works:
 * the query narrows the history to the prompts containing it, the newest first,
 * and pressing Ctrl+R again steps on to the next older one.
 */

export interface HistorySearch {
  /** What has been typed since the search began. */
  query: string
  /** How many matches newer than the one shown were stepped past. */
  skipped: number
  /** The draft as it stood before the search, put back when the search is cancelled. */
  original: string
}

/** Begins a search from the draft as it stands. */
export function startHistorySearch(original: string): HistorySearch {
  return { query: '', skipped: 0, original }
}

/** The prompts containing the query, newest first and each once; an empty query matches nothing. */
export function historyMatches(history: string[], query: string): string[] {
  if (query === '') return []
  const wanted = query.toLowerCase()
  const matches: string[] = []
  for (let index = history.length - 1; index >= 0; index--) {
    const prompt = history[index]
    if (!prompt.toLowerCase().includes(wanted)) continue
    if (matches.includes(prompt)) continue
    matches.push(prompt)
  }
  return matches
}

/** The prompt the search is showing, or null while nothing matches. */
export function currentHistoryMatch(history: string[], search: HistorySearch): string | null {
  const matches = historyMatches(history, search.query)
  if (matches.length === 0) return null
  return matches[Math.min(search.skipped, matches.length - 1)]
}

/** Adds typed text to the query, going back to the newest match. */
export function appendToQuery(search: HistorySearch, text: string): HistorySearch {
  return { ...search, query: search.query + text, skipped: 0 }
}

/** Takes the last character off the query, going back to the newest match. */
export function trimQuery(search: HistorySearch): HistorySearch {
  return { ...search, query: search.query.slice(0, -1), skipped: 0 }
}

/** Steps to the next older match, staying on the oldest one when there is none further back. */
export function olderMatch(history: string[], search: HistorySearch): HistorySearch {
  const count = historyMatches(history, search.query).length
  if (count === 0) return search
  return { ...search, skipped: Math.min(search.skipped + 1, count - 1) }
}

/** Whether a keystroke adds to the query: a single printable character with no Ctrl, Alt or Meta held. */
export function isQueryCharacter(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>
): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key.length === 1
}
