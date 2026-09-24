// grove-plugin:// serves plugin bundle files: the worker's code, and the pages
// (with their scripts, styles and images) a plugin shows as a file viewer.
// Only loaded + trusted + enabled plugins are served, path-validated to their
// own directory. PLUGIN_SCHEME is declared with the others in main/index.ts.

import { protocol, type CustomScheme } from 'electron'
import { readFile } from 'fs/promises'
import { extname, join } from 'path'
import { isInside } from '../api/broker'
import type { PluginRegistry } from './loader'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

/**
 * The policy a plugin's page runs under: its own files, inline styles and
 * whatever it builds in memory — and no network. A viewer is handed the file it
 * shows; nothing it reads should be able to leave the machine from there.
 */
function pagePolicy(pluginId: string): string {
  const own = `grove-plugin://${pluginId}`
  return [
    "default-src 'none'",
    `script-src ${own} 'wasm-unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    'media-src data: blob:',
    `worker-src ${own} blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

/** Headers for one served file; pages also get their policy. */
function headersFor(pluginId: string, fullPath: string): Record<string, string> {
  const extension = extname(fullPath).toLowerCase()
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    // A viewer page runs in a sandboxed frame, whose origin is opaque; its
    // module scripts load in CORS mode and need this to be let through.
    'Access-Control-Allow-Origin': '*'
  }
  if (extension === '.html') headers['Content-Security-Policy'] = pagePolicy(pluginId)
  return headers
}

export const PLUGIN_SCHEME: CustomScheme = {
  scheme: 'grove-plugin',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}

/** Serve grove-plugin:// bundle files; returns the inverse. */
export function registerPluginProtocol(registry: PluginRegistry): () => void {
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
      return new Response(new Uint8Array(data), { headers: headersFor(pluginId, fullPath) })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  return () => protocol.unhandle('grove-plugin')
}
