// The Git pane: the repository laid out around its commit graph, and GitHub
// beside it as a second tab. Which tab shows and what the graph has selected
// are kept here rather than only in the pane, so a command, an agent or a
// GitHub flow can open the pane on what it wants to show.

import { layout } from '../../../lib/layout.svelte'

export const GIT_PANE = 'git'

export type GitTab = 'repo' | 'github'

export const GIT_TABS: { id: GitTab; title: string }[] = [
  { id: 'repo', title: 'Repository' },
  { id: 'github', title: 'GitHub' }
]

// The graph's top row: the uncommitted work in the worktree, selected like a
// commit. Not a sha, so it cannot collide with one.
export const WORKING_TREE = 'working-tree'

class GitPaneState {
  tab = $state<GitTab>('repo')
  // The working tree, a commit's sha, or null for nothing.
  selection = $state<string | null>(WORKING_TREE)
  // The commit message being written, kept while another row is selected.
  commitSubject = $state('')
  commitDescription = $state('')
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

/** Reveals the Git pane with the working tree selected: its changes, the commit box, the merge in progress. */
export function showWorkingTree(): void {
  gitPane.selection = WORKING_TREE
  showGitTab('repo')
}
