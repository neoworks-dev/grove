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
import { nibRoutes } from './nib'
import { pluginsRoutes } from './plugins'
import { actionsRoutes } from './actions'
import { settingsRoutes } from './settings'
import { miscRoutes } from './misc'

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
  nibRoutes,
  pluginsRoutes,
  actionsRoutes,
  settingsRoutes,
  miscRoutes
]
