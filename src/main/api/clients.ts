// Client identity for the shared API layer. Plugins (sandboxed workers) and
// external apps (socket connections) both dispatch through the same routes;
// a ClientRecord is the host-stamped identity the broker and routes key on —
// callers never self-report who they are.

import type { PluginPermission } from '../../shared/plugins'
import type { PluginRecord } from '../plugins/loader'

export type ClientKind = 'plugin' | 'app'

export type ClientSource = 'builtin' | 'user' | 'project' | 'external'

export interface ClientRecord {
  // 'plugin:<id>' | 'app:<id>' — unique across kinds, used for grant storage,
  // stream ownership, and identity stamping in shared channels.
  key: string
  kind: ClientKind
  id: string
  name: string
  source: ClientSource
  // Plugin: manifest.permissions. App: scopes granted at pairing time.
  // Undeclared scopes hard-fail in the broker regardless of stored grants.
  declaredScopes: PluginPermission[]
}

export function clientFromPlugin(record: PluginRecord): ClientRecord {
  return {
    key: `plugin:${record.id}`,
    kind: 'plugin',
    id: record.id,
    name: record.manifest.name,
    source: record.source,
    declaredScopes: record.manifest.permissions ?? []
  }
}
