// The main process's own view of nib.
//
// The renderer talks to nib directly over grove-nib://; this is for the parts of
// grove that are not the renderer — the plugin API routes, which have to reach
// sessions without a window being open.

import { readSse } from './sse'
import { nibJson, nibPost, nibRequest, type NibEndpoint } from './transport'

export interface NibSessionRow {
  id: string
  title: string
  workspaceRoot: string
  provider: string
  model: string
  status: string
  live: boolean
}

export interface NibEventRow {
  seq: number
  type: string
  [key: string]: unknown
}

export interface NibProviderModels {
  provider: string
  models: { id: string }[]
}

/** Operations against a running server. Every call fails if it is not up. */
export class NibClient {
  constructor(private resolveEndpoint: () => NibEndpoint | null) {}

  private endpoint(): NibEndpoint {
    const endpoint = this.resolveEndpoint()
    if (!endpoint) throw new Error('the agent server is not running')
    return endpoint
  }

  async listSessions(): Promise<NibSessionRow[]> {
    const response = await nibJson<{ sessions: NibSessionRow[] }>(this.endpoint(), {
      method: 'GET',
      path: '/v1/sessions'
    })
    return response.sessions
  }

  async listModels(): Promise<NibProviderModels[]> {
    const response = await nibJson<{ providers: NibProviderModels[] }>(this.endpoint(), {
      method: 'GET',
      path: '/v1/models'
    })
    return response.providers
  }

  async listEvents(sessionId: string, after = 0): Promise<NibEventRow[]> {
    const response = await nibJson<{ events: NibEventRow[] }>(this.endpoint(), {
      method: 'GET',
      path: `/v1/sessions/${sessionId}/events?after=${after}`
    })
    return response.events
  }

  createSession(workspace: string, title?: string): Promise<NibSessionRow> {
    return nibPost<NibSessionRow>(this.endpoint(), '/v1/sessions', { workspace, title })
  }

  send(sessionId: string, text: string): Promise<void> {
    return this.post(sessionId, {
      type: 'user.message',
      content: [{ type: 'text', text }],
      deliverAs: 'steer'
    })
  }

  interrupt(sessionId: string): Promise<void> {
    return this.post(sessionId, { type: 'user.interrupt' })
  }

  unqueue(sessionId: string, messageId: string): Promise<void> {
    return this.post(sessionId, { type: 'user.unqueue', messageId })
  }

  /**
   * Follow a session's stream. Unlike the review bridge's own subscription this
   * does not reconnect: an observer is scoped to one turn, and the caller ends
   * it when that turn does.
   */
  observe(sessionId: string, onEvent: (event: NibEventRow) => void): () => void {
    let closed = false
    let destroy = (): void => {}

    void (async () => {
      const response = await nibRequest(this.endpoint(), {
        method: 'GET',
        path: `/v1/sessions/${sessionId}/stream?after=0`,
        headers: { accept: 'text/event-stream' }
      }).catch(() => null)
      if (!response) return
      if (closed) {
        response.destroy()
        return
      }
      destroy = () => response.destroy()

      try {
        for await (const frame of readSse(response)) {
          if (closed) break
          onEvent(JSON.parse(frame.data) as NibEventRow)
        }
      } catch {
        // The stream ended or the server went away; the caller's turn is over.
      }
    })()

    return () => {
      closed = true
      destroy()
    }
  }

  private async post(sessionId: string, event: unknown): Promise<void> {
    await nibPost(this.endpoint(), `/v1/sessions/${sessionId}/events`, { events: [event] })
  }
}
