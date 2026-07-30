// grove-nib:// puts the embedded nib server on a same-origin URL the renderer can
// reach. nib speaks plain HTTP with SSE for its event streams, and neither fetch
// nor EventSource can cross from the renderer's origin to a unix socket — so the
// main process forwards both, unchanged, and the renderer's client code stays
// ordinary web code.
//
// `grove-nib://api/v1/...` maps to `/v1/...` on the server. registerNibScheme
// must run before app ready.

import { protocol } from 'electron'
import { proxyToNib } from './transport'
import type { NibServer } from './server'

const HOST = 'api'

export function registerNibScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'grove-nib',
      // `stream` is what lets an SSE response stay open rather than being
      // buffered to completion first.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

export function registerNibProtocol(server: NibServer): void {
  protocol.handle('grove-nib', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== HOST) {
      return new Response('unknown grove-nib host', { status: 404 })
    }

    // The pane can mount before the server has finished starting, and a request
    // is a perfectly good reason to start it.
    try {
      await server.start()
    } catch (error) {
      return problem(503, (error as Error).message)
    }

    const endpoint = server.endpoint()
    if (!endpoint) return problem(503, 'nib is not running')

    try {
      return await proxyToNib(endpoint, request)
    } catch (error) {
      return problem(502, (error as Error).message)
    }
  })
}

// Match nib's own error shape so the renderer has one thing to parse.
function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { status, message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}
