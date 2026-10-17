// The bridge in the native app: svelte-gpui's `invoke` and `listen` against the commands
// and events the Rust host registers in native/src/sidecar.rs.

import { invoke, listen } from '@neoworks/svelte-gpui'
import type { RpcMessage } from '../../sdk/src/protocol'
import { SidecarClient, type SidecarBridge, type SidecarExit, type SidecarStatus } from './client'
import { createWorkbench } from './workbench'

/** The bridge over the host's relay. */
export function gpuiBridge(): SidecarBridge {
  return {
    send: (frame) => invoke('sidecar_send', frame),
    onReply: (handler) => listen<RpcMessage>('sidecar:reply', handler),
    onEvent: (channel, handler) => listen(`sidecar:event:${channel}`, handler),
    onExit: (handler) => listen<SidecarExit>('sidecar:exit', handler),
    status: () => invoke<SidecarStatus>('sidecar_status')
  }
}

/** The sidecar client for this app, and the `workbench` object made from it. */
export function connectSidecar(): { client: SidecarClient; workbench: ReturnType<typeof createWorkbench> } {
  const client = new SidecarClient(gpuiBridge())
  return { client, workbench: createWorkbench(client) }
}
