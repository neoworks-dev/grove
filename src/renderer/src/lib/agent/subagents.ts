// Subagents derived from the main agent stream: each Task/Agent tool call is a
// subagent, running until its tool-result arrives. Pure over the item list.

import type { OutputItem } from '../agentStream'

export interface Subagent {
  key: string
  type: string
  description: string
  running: boolean
}

export function buildSubagents(items: OutputItem[]): Subagent[] {
  const resultKeys = new Set(
    items.filter((item) => item.kind === 'tool-result').map((item) => item.key)
  )
  const list: Subagent[] = []
  for (const item of items) {
    // Modern SDK names the subagent tool `Agent`; older builds used `Task`.
    if (item.kind !== 'tool' || (item.tool !== 'Agent' && item.tool !== 'Task')) continue
    const input = item.input
    list.push({
      key: item.key,
      type: String(input.subagent_type || 'agent'),
      description: String(input.description || input.prompt || ''),
      running: !resultKeys.has(`result:${item.key}`)
    })
  }
  return list
}
