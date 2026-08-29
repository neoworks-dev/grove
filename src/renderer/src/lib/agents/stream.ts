// Live session events.
//
// The main process pushes every session's events on one channel; a listener
// keeps the ones it asked for. Replay and the live stream overlap by design —
// each event carries a sequence number and the transcript fold ignores anything
// it has already seen — so nothing is lost between loading history and
// subscribing.

import type { SessionEvent } from './types'

const CHANNEL = 'event:agent-event'

export function openStream(
  sessionId: string,
  _afterSeq: number,
  onEvent: (event: SessionEvent) => void
): () => void {
  return window.workbench.on(CHANNEL, (payload) => {
    const event = payload as SessionEvent
    if (event.sessionId === sessionId) onEvent(event)
  })
}
