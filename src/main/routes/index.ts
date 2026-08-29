// Every domain of the IPC surface, one plugin each. Order is irrelevant: each
// declares the services it needs through `inject`.

import { repoRoutes } from './repo'
import { worktreesRoutes } from './worktrees'
import { gitRoutes } from './git'
import { checkpointsRoutes } from './checkpoints'
import { configRoutes } from './config'
import { servicesRoutes } from './services'
import { reviewRoutes } from './review'
import { chatRoutes } from './chat'
import { filesRoutes } from './files'
import { editorCatalogRoutes } from './editorCatalog'
import { lspRoutes } from './lsp'
import { terminalsRoutes } from './terminals'
import { nvimRoutes } from './nvim'
import { stateRoutes } from './state'
import { agentRoutes } from './agents'
import { pluginsRoutes } from './plugins'
import { actionsRoutes } from './actions'
import { settingsRoutes } from './settings'
import { miscRoutes } from './misc'
import { claudeHarness } from '../agents/harnesses/claude'
import { codexHarness } from '../agents/harnesses/codex'
import { piHarness } from '../agents/harnesses/pi'

export const routePlugins = [
  repoRoutes,
  worktreesRoutes,
  gitRoutes,
  checkpointsRoutes,
  configRoutes,
  servicesRoutes,
  reviewRoutes,
  chatRoutes,
  filesRoutes,
  editorCatalogRoutes,
  lspRoutes,
  terminalsRoutes,
  nvimRoutes,
  stateRoutes,
  agentRoutes,
  pluginsRoutes,
  actionsRoutes,
  settingsRoutes,
  miscRoutes,
  // Agent harnesses. Each registers itself into the harness registry and can be
  // unloaded without the rest noticing; adding another means adding a file here.
  claudeHarness,
  codexHarness,
  piHarness
]
