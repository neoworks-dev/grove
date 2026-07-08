// grove-plugin:// serves plugin bundle files to the renderer's plugin workers.
// Only loaded + trusted + enabled plugins are served, path-validated to their
// own directory. registerPluginScheme must run before app ready.

import { protocol } from 'electron'
import { readFile } from 'fs/promises'
import { extname, join } from 'path'
import { isInside } from './broker'
import type { PluginRegistry } from './loader'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm'
}

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'grove-plugin',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

export function registerPluginProtocol(registry: PluginRegistry): void {
  protocol.handle('grove-plugin', async (request) => {
    const url = new URL(request.url)
    const pluginId = url.hostname
    const relPath = decodeURIComponent(url.pathname).replace(/^\//, '')
    const record = registry.get(pluginId)
    if (!record || record.status !== 'ready') {
      return new Response('plugin not available', { status: 404 })
    }
    const fullPath = join(record.root, relPath)
    if (!isInside(record.root, fullPath)) {
      return new Response('forbidden', { status: 403 })
    }
    try {
      const data = await readFile(fullPath)
      const contentType = CONTENT_TYPES[extname(fullPath)] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': contentType } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
