// Re-exports of the plugin wire contract for main and renderer code. The
// source of truth lives in the SDK package so published plugins and the host
// can never drift apart.

export type {
  PluginManifest,
  PluginPermission,
  PluginContributions,
  CommandContribution,
  KeybindingContribution,
  OverlayContribution,
  SidebarContribution,
  MenuContribution,
  StatusBarContribution,
  PaneContribution,
  ViewContribution,
  ActivationEvent,
  ManifestValidation,
  RpcMessage,
  RpcError
} from '../../sdk/src/protocol'

export {
  GROVE_API_VERSION,
  PLUGIN_PERMISSIONS,
  PLUGIN_ID_PATTERN,
  validateManifest,
  isValidActivationEvent
} from '../../sdk/src/protocol'
