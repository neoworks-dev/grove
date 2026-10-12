// The core plugin set. Order is irrelevant: each plugin declares what it needs
// through `inject`, and the kernel runs it once those services exist.

import { explorer } from './explorer'
import { worktrees } from './worktrees'
import { git } from './git'
import { agents } from './agents'
import { replay } from './replay'
import { promptBlame } from './promptBlame'
import { extensionsView } from './extensions'
import { markdownPreview } from './markdownPreview'
import { mediaViewers } from './mediaViewers'
import { diagnostics } from './diagnostics'
import { debugging } from './debug'
import { terminal } from './terminal'
import { logs } from './logs'
import { settingsPanes } from './settingsPanes'
import { designSystem } from './designSystem'
import { views } from './views.svelte'
import { statusBar } from './statusBar'
import { workbench } from './workbench'

export const corePlugins = [
  workbench,
  views,
  statusBar,
  explorer,
  worktrees,
  git,
  agents,
  replay,
  promptBlame,
  extensionsView,
  markdownPreview,
  mediaViewers,
  diagnostics,
  debugging,
  terminal,
  logs,
  settingsPanes,
  designSystem
]
