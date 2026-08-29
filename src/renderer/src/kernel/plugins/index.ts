// The core plugin set. Order is irrelevant: each plugin declares what it needs
// through `inject`, and the kernel runs it once those services exist.

import { explorer } from './explorer'
import { worktrees } from './worktrees'
import { gitChanges } from './gitChanges'
import { agents } from './agents'
import { checkpoints } from './checkpoints'
import { extensionsView } from './extensionsView'
import { setup } from './setup'
import { markdownPreview } from './markdownPreview'
import { diagnostics } from './diagnostics'
import { terminal } from './terminal'
import { dashboard } from './dashboard'
import { logs } from './logs'
import { settingsPanes } from './settingsPanes'
import { views } from './views.svelte'
import { statusBar } from './statusBar'
import { workbench } from './workbench'

export const corePlugins = [
  workbench,
  views,
  statusBar,
  explorer,
  worktrees,
  gitChanges,
  agents,
  checkpoints,
  extensionsView,
  setup,
  markdownPreview,
  diagnostics,
  terminal,
  dashboard,
  logs,
  settingsPanes
]
