// The renderer's client for agent sessions.
//
// Everything goes over IPC: the harnesses run in the main process, next to the
// review flow and the file watcher, and the renderer only ever asks. The one
// exception is an attachment, which is fetched by URL so an <img> can point
// straight at it.

import type {
  BlobDescriptor,
  ClientEventBody,
  CreateSessionOptions,
  FileMatch,
  HarnessCatalog,
  HarnessInfo,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
  SessionUpdate
} from './types'

const agents = (): Window['workbench']['agents'] => window.workbench.agents

export function listHarnesses(): Promise<HarnessInfo[]> {
  return agents().harnesses()
}

export function getCatalog(harnessId: string): Promise<HarnessCatalog> {
  return agents().catalog(harnessId)
}

export function listSessions(): Promise<SessionMeta[]> {
  return agents().listSessions()
}

export function createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
  return agents().createSession(options)
}

export function getSession(sessionId: string): Promise<SessionSnapshot> {
  return agents().getSession(sessionId)
}

export function updateSession(
  sessionId: string,
  changes: SessionUpdate
): Promise<{ changed: string[]; session: SessionSnapshot }> {
  return agents().updateSession(sessionId, changes)
}

export function deleteSession(sessionId: string): Promise<void> {
  return agents().deleteSession(sessionId)
}

export function listEvents(sessionId: string, after = 0): Promise<SessionEvent[]> {
  return agents().listEvents(sessionId, after)
}

export function sendEvents(
  sessionId: string,
  events: ClientEventBody[]
): Promise<{ lastSeq: number }> {
  return agents().sendEvents(sessionId, events)
}

export function searchFiles(sessionId: string, query: string, limit = 20): Promise<FileMatch[]> {
  return agents().searchFiles(sessionId, query, limit)
}

/** Store an attachment beside the session; the transcript then reads it by ref. */
export async function uploadBlob(sessionId: string, file: File): Promise<BlobDescriptor> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = file.type.length > 0 ? file.type : 'application/octet-stream'
  return agents().uploadBlob(sessionId, bytes, mediaType, file.name)
}

/** Where an attachment can be fetched from. Served by the main process. */
export function blobUrl(sessionId: string, ref: string): string {
  return `grove-agent://blob/${sessionId}/${ref}`
}
