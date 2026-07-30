// Vendored from nib (web/src/renderer/lib/stream.ts), reformatted to grove's
// style and pointed at the grove-nib:// origin.
/**
 * SSE subscription.
 *
 * nib names every frame (`event: agent.message_delta`), so the default `message` handler never
 * fires — one listener per known type instead. `?after=` seeds the cursor for the first connect;
 * the browser resends `Last-Event-ID` on reconnect, and the server replays exactly the gap.
 */

import { NIB_ORIGIN } from './api'
import { EVENT_TYPES, type SessionEvent } from './types'

export function openStream(
  sessionId: string,
  afterSeq: number,
  onEvent: (event: SessionEvent) => void
): () => void {
  const source = new EventSource(
    `${NIB_ORIGIN}/v1/sessions/${sessionId}/stream?after=${afterSeq}`
  )

  const handle = (message: MessageEvent<string>): void => {
    onEvent(JSON.parse(message.data) as SessionEvent)
  }

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, handle as EventListener)
  }

  return () => source.close()
}
