// The Git pane's tabs: the commit graph and GitHub, in one center pane. Which
// tab shows is kept here rather than only in the pane, so a command, a button
// in Source Control or an agent can open the pane on the tab it wants.

import { layout } from '../../../lib/layout.svelte'

export const GIT_PANE = 'git'

export type GitTab = 'graph' | 'github'

export const GIT_TABS: { id: GitTab; title: string }[] = [
  { id: 'graph', title: 'Graph' },
  { id: 'github', title: 'GitHub' }
]

class GitPaneState {
  tab = $state<GitTab>('graph')
}

export const gitPane = new GitPaneState()

/** Whether a stored value names one of the Git pane's tabs. */
export function isGitTab(value: unknown): value is GitTab {
  return GIT_TABS.some((tab) => tab.id === value)
}

/** Reveals the Git pane on one of its tabs. */
export function showGitTab(tab: GitTab): void {
  gitPane.tab = tab
  layout.ensurePane(GIT_PANE)
}
