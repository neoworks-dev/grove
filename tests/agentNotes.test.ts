// A session's notes list: kept on the event log, edited by the user and by the
// agent through grove's note tools.
//
// The list is written whole each time, so reading it back is taking the last
// version — and the tools have to leave the entries they were not asked about
// exactly as they were, the user's included.

import { describe, expect, test } from 'bun:test'
import { groveTools } from '../src/main/agents/tools'
import { cleanNotes, notesOf, tasksOf } from '../src/main/agents/notes'
import type { GroveTool, GroveToolContext } from '../src/main/agents/harness'
import type { AgentNotes } from '../src/main/agents/noteTools'
import type { SessionEvent, SessionNote } from '../src/shared/agents'

/** An in-memory notes store, one list per session. */
function memoryNotes(start: SessionNote[] = []): AgentNotes & { saved: SessionNote[][] } {
  let current = start
  const saved: SessionNote[][] = []
  return {
    saved,
    notes: () => Promise.resolve(current),
    saveNotes: (_sessionId, notes) => {
      current = notes
      saved.push(notes)
      return Promise.resolve()
    }
  }
}

function toolNamed(name: string, notes: AgentNotes): GroveTool {
  const tools = groveTools({
    chat: {} as never,
    roster: { harnessIds: () => ['claude'] } as never,
    notes,
    screen: { paneTypes: () => [] },
    worktrees: {} as never
  })
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) throw new Error(`${name} is not offered`)
  return tool
}

const CONTEXT: GroveToolContext = {
  sessionId: 'session-1',
  workspaceRoot: '/repo',
  surface: () => {},
  show: () => {}
}

/** A logged event with only the fields the folds read. */
function logged(seq: number, body: Record<string, unknown>): SessionEvent {
  return { id: `e${seq}`, seq, sessionId: 'session-1', createdAt: '', ...body } as SessionEvent
}

const USER_NOTE: SessionNote = { id: 'u1', text: 'Ask about the API', done: false, author: 'user' }

describe('reading the lists back off the log', () => {
  test('the last version of each counts', () => {
    const events = [
      logged(1, { type: 'session.notes', notes: [USER_NOTE] }),
      logged(2, { type: 'agent.tasks', tasks: [{ id: '1', text: 'A', status: 'pending' }] }),
      logged(3, { type: 'session.notes', notes: [] }),
      logged(4, { type: 'agent.message_delta', text: 'hi' })
    ]

    expect(notesOf(events)).toEqual([])
    expect(tasksOf(events)).toEqual([{ id: '1', text: 'A', status: 'pending' }])
  })

  test('a session that never had any has none', () => {
    expect(notesOf([])).toEqual([])
    expect(tasksOf([])).toEqual([])
  })
})

describe('notes saved from the renderer', () => {
  test('keeps real notes and drops the rest', () => {
    const cleaned = cleanNotes([
      USER_NOTE,
      { id: 'x', text: '   ' },
      'not a note',
      { id: 'a1', text: '  Check the tests  ', done: true, author: 'agent' }
    ])

    expect(cleaned).toEqual([
      USER_NOTE,
      { id: 'a1', text: 'Check the tests', done: true, author: 'agent' }
    ])
  })

  test('anything but a list is an empty one', () => {
    expect(cleanNotes({ id: 'u1' })).toEqual([])
  })
})

describe('the note tools', () => {
  test('never stop the turn on an approval', () => {
    const notes = memoryNotes()
    for (const name of ['read_notes', 'add_note', 'update_note', 'remove_note']) {
      expect(toolNamed(name, notes).policy).toBe('allow')
    }
  })

  test('add a note after the ones already there', async () => {
    const notes = memoryNotes([USER_NOTE])

    const result = await toolNamed('add_note', notes).execute({ text: 'Update the docs' }, CONTEXT)

    expect(result.isError).toBeUndefined()
    const saved = notes.saved[0]
    expect(saved[0]).toEqual(USER_NOTE)
    expect(saved[1]).toMatchObject({ text: 'Update the docs', done: false, author: 'agent' })
  })

  test('tick off a note the user wrote, leaving its text alone', async () => {
    const notes = memoryNotes([USER_NOTE])

    await toolNamed('update_note', notes).execute({ id: 'u1', done: true }, CONTEXT)

    expect(notes.saved[0]).toEqual([{ ...USER_NOTE, done: true }])
  })

  test('remove a note', async () => {
    const notes = memoryNotes([USER_NOTE])

    await toolNamed('remove_note', notes).execute({ id: 'u1' }, CONTEXT)

    expect(notes.saved[0]).toEqual([])
  })

  test('an unknown id is an error, and nothing is saved', async () => {
    const notes = memoryNotes([USER_NOTE])

    const result = await toolNamed('update_note', notes).execute(
      { id: 'nope', done: true },
      CONTEXT
    )

    expect(result.isError).toBe(true)
    expect(notes.saved).toEqual([])
  })

  test('read the list with ids, boxes and authors', async () => {
    const notes = memoryNotes([USER_NOTE, { id: 'a1', text: 'Tests', done: true, author: 'agent' }])

    const result = await toolNamed('read_notes', notes).execute({}, CONTEXT)

    expect(result.content).toBe(
      '- [ ] u1: Ask about the API (by the user)\n- [x] a1: Tests (by an agent)'
    )
  })
})
