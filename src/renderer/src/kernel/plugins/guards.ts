// Shared `when` guards for pane registrations.

import { store } from '../../lib/store.svelte'

/** Panes that have nothing to show until a repository is open. */
export function repoOpen(): boolean {
  return store.repo !== null
}
