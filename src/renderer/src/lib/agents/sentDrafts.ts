/**
 * Drafts sent while the agent was busy, kept until they could be taken back.
 *
 * A message sent mid-turn waits — with the harness or in grove's queue — until the agent
 * takes it up, and until then the user can pull it back into the composer to reword it. What
 * was sent is only the outgoing message: the text and each image as its final upload. The
 * composer's own state (the original picture and the marks drawn on it, still editable) is
 * gone once the draft clears, so it is kept here, per session, under the text it was sent as.
 *
 * Bounded: past `limit` the oldest draft is handed back for its owner to release.
 */

interface SentDraft<Draft> {
  sessionId: string
  text: string
  draft: Draft
}

export class SentDrafts<Draft> {
  private drafts: SentDraft<Draft>[] = []

  constructor(private readonly limit: number) {}

  /** Keeps a sent draft; returns the drafts that fell out to make room. */
  keep(sessionId: string, text: string, draft: Draft): Draft[] {
    this.drafts = [...this.drafts, { sessionId, text, draft }]
    const overflow = this.drafts.length - this.limit
    if (overflow <= 0) {
      return []
    }
    const evicted = this.drafts.slice(0, overflow)
    this.drafts = this.drafts.slice(overflow)
    return evicted.map((entry) => entry.draft)
  }

  /** Takes out the newest draft this session sent as `text`, or null when none was kept. */
  take(sessionId: string, text: string): Draft | null {
    for (let index = this.drafts.length - 1; index >= 0; index--) {
      const entry = this.drafts[index]
      if (entry.sessionId !== sessionId || entry.text !== text) {
        continue
      }
      this.drafts = [...this.drafts.slice(0, index), ...this.drafts.slice(index + 1)]
      return entry.draft
    }
    return null
  }

  /** Takes out every kept draft, for its owner to release. */
  clear(): Draft[] {
    const all = this.drafts.map((entry) => entry.draft)
    this.drafts = []
    return all
  }
}
