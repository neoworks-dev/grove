// Every domain of the IPC surface, one plugin each. Order is irrelevant: each
// declares the services it needs through `inject`.

import { repoRoutes } from './repo'
import { worktreesRoutes } from './worktrees'
import { gitRoutes } from './git'
import { githubRoutes } from './github'
import { checkpointsRoutes } from './checkpoints'
import { conflictsRoutes } from './conflicts'
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
import { replayRoutes } from './replay'
import { blameRoutes } from './blame'
import { browserHostRoutes } from './browserHost'
import { pluginsRoutes } from './plugins'
import { actionsRoutes } from './actions'
import { endpointRoutes } from './endpoints'
import { secretsRoutes } from './secrets'
import { settingsRoutes } from './settings'
import { miscRoutes } from './misc'
import { debugRoutes } from './debug'
import { switchboardHarnesses } from '../agents/switchboard/harnesses'
import { debugAdapterPlugins } from '../debug/adapters'

export const routePlugins = [
  repoRoutes,
  worktreesRoutes,
  gitRoutes,
  githubRoutes,
  checkpointsRoutes,
  conflictsRoutes,
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
  replayRoutes,
  blameRoutes,
  browserHostRoutes,
  pluginsRoutes,
  actionsRoutes,
  endpointRoutes,
  secretsRoutes,
  settingsRoutes,
  miscRoutes,
  debugRoutes,
  // Debug adapters, one plugin each, registered into the adapter registry.
  ...debugAdapterPlugins,
  // Agent harnesses. Each registers itself into the harness registry and can be
  // unloaded without the rest noticing; adding another means adding a file here.
  switchboardHarnesses
]
