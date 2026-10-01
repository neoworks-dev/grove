// The core plugin set. Order is irrelevant: each plugin declares what it needs
// through `inject`, and the kernel runs it once those services exist.

import { explorer } from './explorer'
import { worktrees } from './worktrees'
import { gitChanges } from './gitChanges'
import { gitGraph } from './gitGraph'
import { agents } from './agents'
import { checkpoints } from './checkpoints'
import { replay } from './replay'
import { promptBlame } from './promptBlame'
import { extensionsView } from './extensions'
import { markdownPreview } from './markdownPreview'
import { mediaViewers } from './mediaViewers'
import { diagnostics } from './diagnostics'
import { terminal } from './terminal'
import { githubDashboard } from './github'
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
  gitGraph,
  agents,
  checkpoints,
  replay,
  promptBlame,
  extensionsView,
  markdownPreview,
  mediaViewers,
  diagnostics,
  terminal,
  githubDashboard,
  logs,
  settingsPanes
]
