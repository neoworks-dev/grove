// Claude Code's plan, followed through its task tools.
//
// Claude never reports its task list; it changes it through tool calls, and a
// new task's id only shows up in the result of the call that made it. The list
// also has to carry over from one run to the next, since grove restarting does
// not end Claude's plan.

import { describe, expect, test } from 'bun:test'
import { ClaudeTaskList } from '../src/main/agents/harnesses/claudeTasks'

describe('ClaudeTaskList', () => {
  test('adds a task once its creation comes back with an id', () => {
    const list = new ClaudeTaskList([])

    expect(list.noteToolUse('call-1', 'TaskCreate', { subject: 'Write the parser' })).toBe(false)
    expect(list.noteToolResult('call-1', 'Task #1 created successfully: Write the parser', false))
      .toBe(true)

    expect(list.current()).toEqual([{ id: '1', text: 'Write the parser', status: 'pending' }])
  })

  test('a creation that failed adds nothing', () => {
    const list = new ClaudeTaskList([])

    list.noteToolUse('call-1', 'TaskCreate', { subject: 'Write the parser' })

    expect(list.noteToolResult('call-1', 'Something went wrong', true)).toBe(false)
    expect(list.current()).toEqual([])
  })

  test('moves a task along and deletes it', () => {
    const list = new ClaudeTaskList([{ id: '1', text: 'Write the parser', status: 'pending' }])

    list.noteToolUse('call-2', 'TaskUpdate', { taskId: '1', status: 'in_progress' })
    list.noteToolResult('call-2', 'Updated task #1 status', false)
    expect(list.current()[0].status).toBe('in_progress')

    list.noteToolUse('call-3', 'TaskUpdate', { taskId: '1', status: 'deleted' })
    list.noteToolResult('call-3', 'Updated task #1 deleted', false)
    expect(list.current()).toEqual([])
  })

  test('continues from the list an earlier run left', () => {
    const list = new ClaudeTaskList([
      { id: '4', text: 'Run the tests', status: 'in_progress' }
    ])

    list.noteToolUse('call-1', 'TaskUpdate', { taskId: '4', status: 'completed' })
    list.noteToolResult('call-1', 'Updated task #4 status', false)

    expect(list.current()).toEqual([{ id: '4', text: 'Run the tests', status: 'completed' }])
  })

  test('TodoWrite replaces the whole list', () => {
    const list = new ClaudeTaskList([{ id: '9', text: 'Old', status: 'pending' }])

    const changed = list.noteToolUse('call-1', 'TodoWrite', {
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' }
      ]
    })

    expect(changed).toBe(true)
    expect(list.current()).toEqual([
      { id: '1', text: 'Read the code', status: 'completed' },
      { id: '2', text: 'Fix it', status: 'in_progress' }
    ])
  })

  test('other tools leave it alone', () => {
    const list = new ClaudeTaskList([])

    expect(list.noteToolUse('call-1', 'Read', { file_path: '/repo/a.ts' })).toBe(false)
    expect(list.noteToolResult('call-1', 'Task #1 created successfully', false)).toBe(false)
    expect(list.current()).toEqual([])
  })

  test('a cleared conversation empties it', () => {
    const list = new ClaudeTaskList([{ id: '1', text: 'Write the parser', status: 'pending' }])

    expect(list.clear()).toBe(true)
    expect(list.current()).toEqual([])
    expect(list.clear()).toBe(false)
  })
})
