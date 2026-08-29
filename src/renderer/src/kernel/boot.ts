// Kernel boot. Runs before the first component renders, because the core
// plugins provide the services those components read off the context.

import { groveContext } from './context'
import { coreServices } from './coreServices'
import { SidebarService } from './plugins/sidebar'
import { PanelService } from './services/panel'
import { EditorService } from './services/editor'
import { corePlugins } from './plugins'

/**
 * Mount the core plugins onto the root context and wait for them to go ACTIVE:
 * first the registries, then the three surfaces that host everything else
 * (sidebar, editor, panel), then the features that contribute into them.
 */
export async function bootKernel(): Promise<void> {
  await groveContext.plugin(coreServices)
  await Promise.all([
    groveContext.plugin(SidebarService),
    groveContext.plugin(PanelService),
    groveContext.plugin(EditorService)
  ])
  await Promise.all(corePlugins.map((plugin) => groveContext.plugin(plugin)))
}
