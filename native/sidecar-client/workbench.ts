// A `window.workbench` for the native UI: the same namespaces and methods the Electron
// preload exposes (src/preload/index.ts), each one a call to the sidecar's route, so
// renderer code that calls `workbench.git.branchStatus(id)` runs unchanged.

import type { WorkbenchApi } from '../../src/preload/index.d'
import type { SidecarClient } from './client'
import { workbenchChannels } from './channels'

/** Methods the Electron preload answers in the renderer itself, which have no route to call. */
const NOT_AVAILABLE_NATIVELY = ['files.pathForFile']

/** Builds the nested `workbench` object from the channel table, over the client. */
export function createWorkbench(
  client: SidecarClient,
  channels: Record<string, string> = workbenchChannels
): WorkbenchApi {
  const workbench: Record<string, unknown> = {
    debug: false,
    on: (channel: string, handler: (payload: unknown) => void) => client.on(channel, handler)
  }
  for (const [path, channel] of Object.entries(channels)) {
    addMethod(workbench, path.split('.'), (...args: unknown[]) => client.call(channel, ...args))
  }
  for (const path of NOT_AVAILABLE_NATIVELY) {
    addMethod(workbench, path.split('.'), () => {
      throw new Error(`workbench.${path} is not available in the native app`)
    })
  }
  return workbench as unknown as WorkbenchApi
}

/** Puts `method` at `path` in the nested object, creating the namespaces on the way. */
function addMethod(root: Record<string, unknown>, path: string[], method: unknown): void {
  let namespace = root
  for (const name of path.slice(0, -1)) {
    if (typeof namespace[name] !== 'object') {
      namespace[name] = {}
    }
    namespace = namespace[name] as Record<string, unknown>
  }
  namespace[path[path.length - 1]] = method
}
