// The notes list, as the agent reaches it.
//
// A session's notes sit above its composer: reminders of what is still to do,
// kept by the user and the agent alike. These tools are the agent's half — the
// same list the user edits, so either can tick off what the other wrote.

import type { SessionNote } from '../../../shared/agents'
import type { GroveTool } from '../harness'
import { newNote, noteText } from '../notes'

/** Where a session's notes list is kept. */
export interface AgentNotes {
  notes(sessionId: string): Promise<SessionNote[]>
  saveNotes(sessionId: string, notes: SessionNote[]): Promise<void>
}

/** The four note tools, reading and writing through `store`. */
export function noteTools(store: AgentNotes): GroveTool[] {
  const read: GroveTool = {
    name: 'read_notes',
    summary: 'Read the notes pinned above the composer.',
    description:
      'Read the notes list the user sees above the composer: reminders of what is still to ' +
      'do, written by the user or by you. Check it when you pick work back up, and before ' +
      'saying you are done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    policy: 'allow',
    display: { label: 'notes', input: 'hidden', result: 'list' },

    async execute(_input, context) {
      return { content: describeNotes(await store.notes(context.sessionId)) }
    }
  }

  const add: GroveTool = {
    name: 'add_note',
    summary: 'Pin a note above the composer.',
    description:
      'Pin a note to the list above the composer, where the user keeps it in view. Use it for ' +
      'something that must not be forgotten — a follow-up, an open question, a step left for ' +
      'later — not for your step-by-step plan, which belongs in your own task list.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note, in one line.' } },
      required: ['text'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{text}', input: 'hidden', result: 'hidden' },

    async execute(input, context) {
      const text = noteText(String(input.text ?? ''))
      if (text.length === 0) return { content: 'A note needs some text.', isError: true }
      const note = newNote(text, 'agent')
      const notes = await store.notes(context.sessionId)
      await store.saveNotes(context.sessionId, [...notes, note])
      return { content: `Pinned note ${note.id}.` }
    }
  }

  const update: GroveTool = {
    name: 'update_note',
    summary: 'Tick off or reword a note.',
    description:
      'Change a note on the list: mark it done once it is, or reword it. Pass the id ' +
      '`read_notes` reports. Notes the user wrote can be ticked off too, when you have done ' +
      'what they say.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id, as `read_notes` reports it.' },
        done: { type: 'boolean', description: 'Whether the note is done.' },
        text: { type: 'string', description: 'New text for the note.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{id}', input: 'hidden', result: 'hidden' },

    async execute(input, context) {
      const notes = await store.notes(context.sessionId)
      const target = notes.find((note) => note.id === input.id)
      if (!target) return unknownNote(input.id)
      const changed = { ...target }
      if (typeof input.done === 'boolean') changed.done = input.done
      if (typeof input.text === 'string' && noteText(input.text).length > 0) {
        changed.text = noteText(input.text)
      }
      const next = notes.map((note) => (note.id === target.id ? changed : note))
      await store.saveNotes(context.sessionId, next)
      return { content: `Updated note ${target.id}.` }
    }
  }

  const remove: GroveTool = {
    name: 'remove_note',
    summary: 'Take a note off the list.',
    description:
      'Remove a note from the list altogether. Prefer marking it done with `update_note`, so ' +
      'the user sees it was dealt with; remove only what was wrong or is no longer wanted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id, as `read_notes` reports it.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    policy: 'allow',
    display: { label: '{id}', input: 'hidden', result: 'hidden' },

    async execute(input, context) {
      const notes = await store.notes(context.sessionId)
      if (!notes.some((note) => note.id === input.id)) return unknownNote(input.id)
      await store.saveNotes(
        context.sessionId,
        notes.filter((note) => note.id !== input.id)
      )
      return { content: `Removed note ${String(input.id)}.` }
    }
  }

  return [read, add, update, remove]
}

/** The list as the model reads it. */
function describeNotes(notes: SessionNote[]): string {
  if (notes.length === 0) return 'No notes.'
  return notes.map(describeNote).join('\n')
}

/** One note as the model reads it: its box, its id, its text and who wrote it. */
function describeNote(note: SessionNote): string {
  let box = '[ ]'
  if (note.done) box = '[x]'
  let author = 'the user'
  if (note.author === 'agent') author = 'an agent'
  return `- ${box} ${note.id}: ${note.text} (by ${author})`
}

/** The answer to an id that names no note. */
function unknownNote(id: unknown): { content: string; isError: true } {
  return {
    content: `No note "${String(id)}". Call \`read_notes\` for the ids.`,
    isError: true
  }
}
