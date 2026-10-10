// The composer's stash: a draft set aside with Ctrl+S, to be brought back on an empty
// composer. Holds one draft, so stashing again releases the one it displaces.

/** Whether a keystroke is Ctrl+S with no other modifier. */
export function isStashKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>
): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
  return event.key.toLowerCase() === 's'
}

export class PromptStash<Draft> {
  private held: Draft | null = null

  /** Holds a draft in place of any held one; returns the draft that was displaced, or null. */
  put(draft: Draft): Draft | null {
    const displaced = this.held
    this.held = draft
    return displaced
  }

  /** Takes the held draft out, or returns null when nothing is stashed. */
  take(): Draft | null {
    const draft = this.held
    this.held = null
    return draft
  }
}
