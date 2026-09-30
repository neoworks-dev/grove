// A session's notes list, read back off its event log.
//
// It is kept on the log as a whole list — `session.notes` — so the one that
// counts is simply the last, whichever branch of the conversation it was
// written on.

import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionNote } from '../../shared/agents'

// A note is a line to remember, not a document; longer text is cut here so a
// runaway model cannot fill the strip above the composer.
const MAX_NOTE_LENGTH = 500
const MAX_NOTES = 100

/** The notes list as the log last recorded it. */
export function notesOf(events: readonly SessionEvent[]): SessionNote[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'session.notes') return event.notes
  }
  return []
}

/** A new note, not yet done. */
export function newNote(text: string, author: SessionNote['author']): SessionNote {
  return { id: randomUUID().slice(0, 8), text: noteText(text), done: false, author }
}

/**
 * A notes list from the renderer, checked field by field. Anything that is not
 * a note is dropped rather than failing the whole save.
 */
export function cleanNotes(value: unknown): SessionNote[] {
  if (!Array.isArray(value)) return []
  const notes: SessionNote[] = []
  for (const entry of value.slice(0, MAX_NOTES)) {
    const note = cleanNote(entry)
    if (note) notes.push(note)
  }
  return notes
}

/** One note, or null when the entry is not one. */
function cleanNote(value: unknown): SessionNote | null {
  if (typeof value !== 'object' || value === null) return null
  const fields = value as Record<string, unknown>
  if (typeof fields.id !== 'string' || typeof fields.text !== 'string') return null
  const text = noteText(fields.text)
  if (text.length === 0) return null
  let author: SessionNote['author'] = 'user'
  if (fields.author === 'agent') author = 'agent'
  return { id: fields.id, text, done: fields.done === true, author }
}

/** A note's text: one trimmed stretch, no longer than a note should be. */
export function noteText(text: string): string {
  return text.trim().slice(0, MAX_NOTE_LENGTH)
}
