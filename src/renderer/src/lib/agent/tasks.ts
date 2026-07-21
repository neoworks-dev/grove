// Live task checklist folded from TaskCreate/TaskUpdate tool calls. Pure over
// the item list so it can be unit-tested without the component.

import type { OutputItem } from '../agentStream'
import { TASK_TOOLS } from './transcript'

export interface TaskItem {
  id: string
  subject: string
  status: string
  activeForm: string
}

// The assigned task id lives in the TaskCreate result text ("Task #3
// created…"); fall back to creation order if the format changes.
function taskIdFromResult(text: string | undefined): string | null {
  const match = text?.match(/#(\d+)/)
  if (match) return match[1]
  return null
}

export function buildTaskList(items: OutputItem[]): TaskItem[] {
  const resultsByKey = new Map(
    items
      .filter((item) => item.kind === 'tool-result')
      .map((item) => [item.key, item.text] as const)
  )
  const tasks: TaskItem[] = []
  const tasksById = new Map<string, TaskItem>()
  for (const item of items) {
    if (item.kind !== 'tool' || !TASK_TOOLS.has(item.tool)) continue
    if (item.tool === 'TaskCreate') {
      const fallbackId = String(tasks.length + 1)
      const id = taskIdFromResult(resultsByKey.get(`result:${item.key}`)) || fallbackId
      const task: TaskItem = {
        id,
        subject: String(item.input.subject || ''),
        status: 'pending',
        activeForm: String(item.input.activeForm || '')
      }
      tasks.push(task)
      tasksById.set(id, task)
      continue
    }
    const task = tasksById.get(String(item.input.taskId || ''))
    if (!task) continue
    if (typeof item.input.status === 'string') task.status = item.input.status
    if (typeof item.input.subject === 'string') task.subject = item.input.subject
    if (typeof item.input.activeForm === 'string') task.activeForm = item.input.activeForm
  }
  return tasks.filter((task) => task.status !== 'deleted')
}

// Keys of Task tool-results; folded into the checklist, so hidden as raw rows.
export function taskResultKeys(items: OutputItem[]): Set<string> {
  const keys = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool' && TASK_TOOLS.has(item.tool)) keys.add(`result:${item.key}`)
  }
  return keys
}
