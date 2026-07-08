// Base pane type registrations. Everything the app itself shows goes through
// the same registry plugins use — nothing in the layout engine special-cases
// core panes.

import Folder from 'phosphor-svelte/lib/Folder'
import GitBranch from 'phosphor-svelte/lib/GitBranch'
import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece'
import FilesView from '../components/FilesView.svelte'
import WorktreeSidebar from '../components/WorktreeSidebar.svelte'
import ExtensionsView from '../components/ExtensionsView.svelte'
import EditorPane from '../components/EditorPane.svelte'
import DiffPane from '../components/DiffPane.svelte'
import PreviewPane from '../components/PreviewPane.svelte'
import Dashboard from '../components/Dashboard.svelte'
import AgentPane from '../components/AgentPane.svelte'
import LogsPane from '../components/LogsPane.svelte'
import { panes } from './panes.svelte'
import { store } from './store.svelte'

// Pane types that swap in place when launched (see PaneType.slot).
export const SIDEBAR_SLOT = 'sidebar'
export const CENTER_SLOT = 'center'

function repoOpen(): boolean {
  return store.repo !== null
}

export function registerCorePanes(): void {
  panes.register({
    id: 'files',
    title: 'Explorer',
    icon: Folder,
    component: FilesView,
    rail: { order: 1 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180
  })
  panes.register({
    id: 'worktrees',
    title: 'Worktrees',
    icon: GitBranch,
    component: WorktreeSidebar,
    rail: { order: 2 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180
  })
  panes.register({
    id: 'extensions',
    title: 'Extensions',
    icon: PuzzlePiece,
    component: ExtensionsView,
    rail: { order: 3 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180
  })
  panes.register({
    id: 'editor',
    title: 'Editor',
    component: EditorPane,
    slot: CENTER_SLOT,
    minWidth: 240,
    when: repoOpen
  })
  panes.register({
    id: 'diff',
    title: 'Diff',
    component: DiffPane,
    slot: CENTER_SLOT,
    minWidth: 240,
    when: repoOpen
  })
  panes.register({
    id: 'preview',
    title: 'Preview',
    component: PreviewPane,
    slot: CENTER_SLOT,
    minWidth: 240,
    when: repoOpen
  })
  panes.register({
    id: 'dashboard',
    title: 'Dashboard',
    component: Dashboard,
    slot: CENTER_SLOT,
    minWidth: 240,
    when: repoOpen
  })
  panes.register({
    id: 'agent',
    title: 'Agent',
    component: AgentPane,
    containerClass: 'bg-elevated',
    minWidth: 240
  })
  panes.register({
    id: 'logs',
    title: 'Logs',
    component: LogsPane,
    containerClass: 'bg-elevated',
    minHeight: 120
  })
}
