// Base pane type registrations. Everything the app itself shows goes through
// the same registry plugins use — nothing in the layout engine special-cases
// core panes.

import Folder from 'phosphor-svelte/lib/Folder'
import GitBranch from 'phosphor-svelte/lib/GitBranch'
import GitDiff from 'phosphor-svelte/lib/GitDiff'
import PuzzlePiece from 'phosphor-svelte/lib/PuzzlePiece'
import Warning from 'phosphor-svelte/lib/Warning'
import Eye from 'phosphor-svelte/lib/Eye'
import TerminalWindow from 'phosphor-svelte/lib/TerminalWindow'
import Robot from 'phosphor-svelte/lib/Robot'
import ClockCounterClockwise from 'phosphor-svelte/lib/ClockCounterClockwise'
import ChatCircle from 'phosphor-svelte/lib/ChatCircle'
import FilesView from '../components/FilesView.svelte'
import WorktreeSidebar from '../components/WorktreeSidebar.svelte'
import GitChangesView from '../components/GitChangesView.svelte'
import DiagnosticsPane from '../components/DiagnosticsPane.svelte'
import MarkdownPreviewPane from '../components/MarkdownPreviewPane.svelte'
import ExtensionsView from '../components/ExtensionsView.svelte'
import AgentsOverview from '../components/AgentsOverview.svelte'
import CheckpointsView from '../components/CheckpointsView.svelte'
import WorktreeChatPane from '../components/WorktreeChatPane.svelte'
import NvimPane from '../components/NvimPane.svelte'
import Dashboard from '../components/Dashboard.svelte'
import EmptyCenter from '../components/EmptyCenter.svelte'
import AgentPane from '../components/agent/AgentPane.svelte'
import LogsPane from '../components/LogsPane.svelte'
import TerminalPane from '../components/TerminalPane.svelte'
import BottomPanel from '../components/BottomPanel.svelte'
import PreferencesPane from '../components/PreferencesPane.svelte'
import KeyboardPane from '../components/KeyboardPane.svelte'
import { panes } from './panes.svelte'
import { panels } from './panels.svelte'
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
    id: 'changes',
    title: 'Git Changes',
    icon: GitDiff,
    component: GitChangesView,
    rail: { order: 3 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180,
    when: repoOpen
  })
  panes.register({
    id: 'agents',
    title: 'Agents',
    icon: Robot,
    component: AgentsOverview,
    rail: { order: 4 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180,
    when: repoOpen
  })
  panes.register({
    id: 'diagnostics',
    title: 'Diagnostics',
    icon: Warning,
    component: DiagnosticsPane,
    slot: CENTER_SLOT,
    preferredOrientation: 'column',
    minWidth: 320,
    minHeight: 100,
    when: repoOpen
  })
  panes.register({
    id: 'markdown',
    title: 'Markdown Preview',
    icon: Eye,
    component: MarkdownPreviewPane,
    slot: CENTER_SLOT,
    preferredOrientation: 'row',
    minWidth: 320,
    when: repoOpen
  })
  panes.register({
    id: 'checkpoints',
    title: 'Checkpoints',
    icon: ClockCounterClockwise,
    component: CheckpointsView,
    rail: { order: 5 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180,
    when: repoOpen
  })
  panes.register({
    id: 'extensions',
    title: 'Extensions',
    icon: PuzzlePiece,
    component: ExtensionsView,
    rail: { order: 6 },
    slot: SIDEBAR_SLOT,
    containerClass: 'bg-elevated',
    minWidth: 180
  })
  // Right-dock utility pane (chosen from the dock picker or the worktree row's
  // chat button); no rail entry and no sidebar slot so it docks right, not left.
  panes.register({
    id: 'worktree-chat',
    title: 'Worktree Chat',
    icon: ChatCircle,
    component: WorktreeChatPane,
    containerClass: 'bg-elevated',
    minWidth: 240,
    when: repoOpen
  })
  panes.register({
    id: 'nvim',
    title: 'Neovim',
    component: NvimPane,
    slot: CENTER_SLOT,
    minWidth: 240,
    // Reports the 'editor' keymap context so editor-scoped bindings (file
    // finder, etc.) match here.
    contextType: 'editor',
    // Modes reported live from the embedded nvim's mode_change events.
    modes: ['normal', 'insert', 'visual', 'replace', 'cmdline', 'operator', 'terminal'],
    ownsFontScale: true,
    when: repoOpen
  })
  // Placeholder for an empty center leaf; renders its own empty state, so no
  // `when` guard (it must show even before a repo is open).
  panes.register({
    id: 'empty',
    title: 'Empty',
    component: EmptyCenter,
    slot: CENTER_SLOT,
    minWidth: 240
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
    minWidth: 240,
    // Vim-style: 'normal' scrolls the transcript and navigates instances; 'i'
    // enters 'insert', which focuses the composer; Escape returns to 'normal'.
    modes: ['normal', 'insert']
  })
  panes.register({
    id: 'logs',
    title: 'Logs',
    component: LogsPane,
    containerClass: 'bg-elevated',
    minHeight: 120
  })
  panes.register({
    id: 'terminal',
    title: 'Terminal',
    icon: TerminalWindow,
    component: TerminalPane,
    containerClass: 'bg-canvas',
    minHeight: 120,
    // 'terminal' forwards every key to the shell; ctrl+\ ctrl+n drops to
    // 'normal' so global chords (ctrl+hjkl, leader) work; 'i' returns.
    modes: ['terminal', 'normal'],
    ownsFontScale: true,
    when: repoOpen
  })
  panes.register({
    id: 'panel',
    title: 'Panel',
    icon: TerminalWindow,
    component: BottomPanel,
    slot: CENTER_SLOT,
    // Open below the focused editor, like the diagnostics pane.
    preferredOrientation: 'column',
    containerClass: 'bg-canvas',
    minHeight: 160,
    // The Terminal tab forwards keys to the shell ('terminal'); other tabs run
    // in 'normal'. The active tab reports which.
    modes: ['terminal', 'normal'],
    ownsFontScale: true,
    when: repoOpen
  })
  // Built-in bottom-panel tabs. Plugins add more via the manifest `panel` flag.
  panels.register({
    id: 'terminal',
    title: 'Terminal',
    icon: TerminalWindow,
    paneTypeId: 'terminal',
    order: 10
  })
  panels.register({
    id: 'diagnostics',
    title: 'Problems',
    icon: Warning,
    paneTypeId: 'diagnostics',
    order: 20
  })
  panes.register({
    id: 'preferences',
    title: 'Preferences',
    component: PreferencesPane,
    slot: CENTER_SLOT,
    minWidth: 320
  })
  panes.register({
    id: 'keybindings',
    title: 'Keyboard Shortcuts',
    component: KeyboardPane,
    slot: CENTER_SLOT,
    minWidth: 320
  })
}
