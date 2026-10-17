// The UI's way to Grove's main process: see client.ts for the API and gpui.ts for how it
// is wired in the native app.

export { SidecarClient } from './client'
export type { SidecarBridge, SidecarExit, SidecarInfo, SidecarStatus } from './client'
export { createWorkbench } from './workbench'
export { connectSidecar, gpuiBridge } from './gpui'
