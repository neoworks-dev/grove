// Vendored from nib (web/src/renderer/lib/api.ts), reformatted to grove's style.
// The only behavioural change is the base URL: nib's own client talks to a
// same-origin `/v1`, grove goes through the grove-nib:// scheme its main process
// forwards over the server's socket.
/**
 * HTTP client for the nib server.
 *
 * Every request goes through `grove-nib://api`, which the main process proxies to the embedded
 * server — so this stays ordinary web code and never learns where the socket is.
 */

import type {
  BlobDescriptor,
  ClientEventBody,
  CommandInfo,
  CreateSessionOptions,
  FileMatch,
  ProviderModels,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionTree,
  SessionUpdate,
  SkillInfo,
  ToolInfo
} from './types'

// The origin the main process registered for the embedded nib server.
export const NIB_ORIGIN = 'grove-nib://api'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${NIB_ORIGIN}/v1${path}`, init)
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response))
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  if (text.trim().length === 0) {
    return `${response.status} ${response.statusText}`
  }

  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    if (body.error && body.error.message) {
      return body.error.message
    }
  } catch {
    // Not a problem document — fall through to the raw body.
  }
  return text
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  return request('/sessions')
}

export function createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
  return request('/sessions', json('POST', options))
}

export function getSession(id: string): Promise<SessionSnapshot> {
  return request(`/sessions/${id}`)
}

export function updateSession(
  id: string,
  changes: SessionUpdate
): Promise<{ changed: string[]; session: SessionSnapshot }> {
  return request(`/sessions/${id}`, json('PATCH', changes))
}

export function deleteSession(id: string): Promise<void> {
  return request(`/sessions/${id}`, { method: 'DELETE' })
}

export function listEvents(
  id: string,
  after = 0
): Promise<{ events: SessionEvent[]; lastSeq: number }> {
  return request(`/sessions/${id}/events?after=${after}`)
}

export function sendEvents(
  id: string,
  events: ClientEventBody[]
): Promise<{ accepted: number; lastSeq: number }> {
  return request(`/sessions/${id}/events`, json('POST', { events }))
}

export function forkSession(id: string, afterSeq: number): Promise<SessionSnapshot> {
  return request(`/sessions/${id}/fork`, json('POST', { afterSeq }))
}

export function compactSession(id: string): Promise<{ summary: string; droppedMessages: number }> {
  return request(`/sessions/${id}/compact`, json('POST', {}))
}

export function setLabel(
  id: string,
  eventId: string,
  label: string | null
): Promise<{ labels: Record<string, string> }> {
  return request(`/sessions/${id}/labels`, json('POST', { eventId, label }))
}

export function getTree(id: string): Promise<SessionTree> {
  return request(`/sessions/${id}/tree`)
}

export function searchFiles(
  id: string,
  query: string,
  limit = 20
): Promise<{ files: FileMatch[] }> {
  return request(`/sessions/${id}/files?q=${encodeURIComponent(query)}&limit=${limit}`)
}

export function listModels(): Promise<{
  default: { provider: string; model: string }
  providers: ProviderModels[]
}> {
  return request('/models')
}

export function listTools(): Promise<{ tools: ToolInfo[] }> {
  return request('/tools')
}

export function listCommands(): Promise<{ commands: CommandInfo[] }> {
  return request('/commands')
}

export function listSkills(): Promise<{ skills: SkillInfo[] }> {
  return request('/skills')
}

/** The body is the raw bytes and `content-type` names the media type — not multipart. */
export function uploadBlob(id: string, file: File): Promise<BlobDescriptor> {
  return request(`/sessions/${id}/blobs`, {
    method: 'POST',
    headers: {
      'content-type': file.type.length > 0 ? file.type : 'application/octet-stream',
      'x-filename': file.name
    },
    body: file
  })
}

export function blobUrl(sessionId: string, ref: string): string {
  return `${NIB_ORIGIN}/v1/sessions/${sessionId}/blobs/${ref}`
}

export function exportUrl(sessionId: string): string {
  return `${NIB_ORIGIN}/v1/sessions/${sessionId}/export?format=jsonl`
}
