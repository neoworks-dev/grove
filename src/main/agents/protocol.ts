// grove-agent:// serves session attachments to the renderer.
//
// An image pasted into the composer is stored beside its session, and the
// transcript shows it with an ordinary <img src>. A file:// URL would reach
// outside the renderer's origin, so the bytes come back through a scheme the
// main process owns. `registerAgentScheme` must run before app ready.

import { protocol } from 'electron'
import type { AgentService } from './service'

const BLOB_HOST = 'blob'

export function registerAgentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'grove-agent',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** Serve grove-agent:// from the session store; returns the inverse. */
export function registerAgentProtocol(agents: AgentService): () => void {
  protocol.handle('grove-agent', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== BLOB_HOST) return new Response('unknown host', { status: 404 })

    const [sessionId, ref] = url.pathname.replace(/^\//, '').split('/')
    if (!sessionId || !ref) return new Response('bad attachment path', { status: 400 })

    try {
      const bytes = await agents.readBlob(sessionId, ref)
      return new Response(new Uint8Array(bytes))
    } catch (cause) {
      return new Response((cause as Error).message, { status: 404 })
    }
  })
  return () => protocol.unhandle('grove-agent')
}

/** The URL the renderer uses for one attachment. */
export function blobUrlFor(sessionId: string, ref: string): string {
  return `grove-agent://${BLOB_HOST}/${sessionId}/${ref}`
}
