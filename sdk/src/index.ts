// Runtime shim for '@grove/plugin-sdk'. The real implementation is injected
// by the Grove worker bootstrap as globalThis.__grove BEFORE the plugin entry
// is imported — this module only forwards to it. Keeping the shim tiny means
// plugin bundles never embed protocol logic and stay compatible across hosts
// (compatibility is checked via manifest.engines.grove).

import type { GroveApi } from './api'

export type * from './api';
export type { PluginManifest, PluginPermission, RpcMessage, RpcError } from './protocol'

declare global {
  // eslint-disable-next-line no-var
  var __grove: GroveApi | undefined
}

function host(): GroveApi {
  const api = globalThis.__grove
  if (!api) {
    throw new Error(
      '@grove/plugin-sdk can only be imported inside a Grove plugin worker (globalThis.__grove is missing)'
    )
  }
  return api
}

export const version: string = host().version
export const commands: GroveApi['commands'] = host().commands
export const keybindings: GroveApi['keybindings'] = host().keybindings
export const ui: GroveApi['ui'] = host().ui
export const panes: GroveApi['panes'] = host().panes
export const views: GroveApi['views'] = host().views
export const workspace: GroveApi['workspace'] = host().workspace
export const ai: GroveApi['ai'] = host().ai
export const settings: GroveApi['settings'] = host().settings
export const events: GroveApi['events'] = host().events
