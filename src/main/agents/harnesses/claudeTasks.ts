// Claude Code's own plan, as a list grove can show.
//
// Claude keeps its plan through tool calls rather than reporting it: `TodoWrite`
// sends the whole list each time, while `TaskCreate` and `TaskUpdate` change one
// task at a time, and only the result of `TaskCreate` says which id the new task
// got. This follows those calls and hands back the list after each change, so
// the adapter can put it on the log as an `agent.tasks` event.

import type { AgentTask, AgentTaskStatus } from '../../../shared/agents'

const TASK_CREATED = /^Task #(\S+) created/

const STATUSES: AgentTaskStatus[] = ['pending', 'in_progress', 'completed']

export class ClaudeTaskList {
  private tasks: AgentTask[]
  /** Calls whose effect is only known from their result, by tool-use id. */
  private pending = new Map<string, { name: string; input: Record<string, unknown> }>()

  /** Continues from the list the session's last run left. */
  constructor(start: AgentTask[]) {
    this.tasks = start.map((task) => ({ ...task }))
  }

  /** The list as it stands. */
  current(): AgentTask[] {
    return this.tasks.map((task) => ({ ...task }))
  }

  /** Follows a tool call; returns true when it changed the list. */
  noteToolUse(toolUseId: string, name: string, input: unknown): boolean {
    const fields = recordOf(input)
    if (name === 'TodoWrite') return this.replaceWithTodos(fields.todos)
    if (name === 'TaskCreate' || name === 'TaskUpdate') {
      this.pending.set(toolUseId, { name, input: fields })
    }
    return false
  }

  /** Follows a tool's result; returns true when it changed the list. */
  noteToolResult(toolUseId: string, content: string, isError: boolean): boolean {
    const call = this.pending.get(toolUseId)
    if (!call) return false
    this.pending.delete(toolUseId)
    if (isError) return false
    if (call.name === 'TaskCreate') return this.create(call.input, content)
    return this.update(call.input)
  }

  /** Claude dropped its conversation, and its plan went with it. */
  clear(): boolean {
    this.pending.clear()
    if (this.tasks.length === 0) return false
    this.tasks = []
    return true
  }

  /** `TodoWrite` sends the whole list; its entries are numbered in order. */
  private replaceWithTodos(value: unknown): boolean {
    if (!Array.isArray(value)) return false
    this.tasks = value.map((entry, index) => {
      const todo = recordOf(entry)
      return { id: String(index + 1), text: textOf(todo.content), status: statusOf(todo.status) }
    })
    return true
  }

  /** `TaskCreate` only learns its id from the result. */
  private create(input: Record<string, unknown>, result: string): boolean {
    const match = TASK_CREATED.exec(result.trim())
    if (!match) return false
    const id = match[1]
    this.tasks = [
      ...this.tasks.filter((task) => task.id !== id),
      { id, text: textOf(input.subject), status: 'pending' }
    ]
    return true
  }

  /** `TaskUpdate` edits one task, or deletes it. */
  private update(input: Record<string, unknown>): boolean {
    const id = String(input.taskId ?? '')
    const task = this.tasks.find((entry) => entry.id === id)
    if (!task) return false
    if (input.status === 'deleted') {
      this.tasks = this.tasks.filter((entry) => entry.id !== id)
      return true
    }
    if (typeof input.subject === 'string') task.text = input.subject
    if (isStatus(input.status)) task.status = input.status
    return true
  }
}

/** Tool inputs arrive unvalidated; anything but an object has no fields. */
function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}

/** A field that should be text, or empty when it is not. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  return ''
}

/** Whether a value is one of the statuses a task can have. */
function isStatus(value: unknown): value is AgentTaskStatus {
  return STATUSES.includes(value as AgentTaskStatus)
}

/** A status the model wrote, or pending when it wrote something else. */
function statusOf(value: unknown): AgentTaskStatus {
  if (isStatus(value)) return value
  return 'pending'
}
