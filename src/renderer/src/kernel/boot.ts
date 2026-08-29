// Kernel boot. Runs before the first component renders, because core plugins
// provide the services those components read off the context.

import { groveContext } from './context'
import { coreServices } from './coreServices'

/**
 * Mount the core plugins onto the root context and wait for them to go ACTIVE.
 * Resolves once `groveContext.commands`, `.panes`, … resolve.
 */
export async function bootKernel(): Promise<void> {
  await groveContext.plugin(coreServices)
}
