// Parses agent output lines into renderable items. Claude's `--output-format
// stream-json` emits one complete JSON event per line; we extract assistant
// text, tool calls (rendered as command cards), and tool results. Non-JSON
// lines (other agents, or stderr) pass through as raw text. Items are keyed so
// re-parsing an appended log never produces visual duplicates.

export type OutputItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tool'; tool: string; input: Record<string, unknown>; key: string }
  | { kind: 'tool-result'; text: string; isError: boolean; key: string }
  | { kind: 'raw'; text: string; key: string }

// Extract plain text from a content value that is either a string or an array
// of content blocks ({ type: 'text', text }).
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text ?? '')
        }
        return ''
      })
      .join('')
  }
  return ''
}

function parseAssistant(event: Record<string, unknown>, items: OutputItem[]): void {
  const message = event.message as { id?: string; content?: unknown[] } | undefined
  if (!message || !Array.isArray(message.content)) return
  const messageId = message.id || 'assistant'
  message.content.forEach((raw, index) => {
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      items.push({ kind: 'text', text: block.text, key: `${messageId}:${index}` })
    } else if (block.type === 'tool_use') {
      items.push({
        kind: 'tool',
        tool: String(block.name || 'tool'),
        input: (block.input as Record<string, unknown>) || {},
        key: String(block.id || `${messageId}:${index}`)
      })
    }
  })
}

function parseUser(event: Record<string, unknown>, items: OutputItem[]): void {
  const message = event.message as { content?: unknown[] } | undefined
  if (!message || !Array.isArray(message.content)) return
  for (const raw of message.content) {
    const block = raw as Record<string, unknown>
    if (block.type !== 'tool_result') continue
    items.push({
      kind: 'tool-result',
      text: contentToText(block.content),
      isError: block.is_error === true,
      key: `result:${String(block.tool_use_id || items.length)}`
    })
  }
}

export function parseAgentLines(lines: string[]): OutputItem[] {
  const items: OutputItem[] = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) {
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>
        if (event.type === 'assistant') parseAssistant(event, items)
        else if (event.type === 'user') parseUser(event, items)
        // 'system' and 'result' events are control/summary noise — the result
        // text merely repeats the last assistant message, so we drop them.
        return
      } catch {
        // fall through to raw rendering
      }
    }
    if (trimmed.length > 0) {
      items.push({ kind: 'raw', text: line, key: `raw:${index}` })
    }
  })

  // Collapse duplicate keys, keeping the first occurrence.
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.key)) return false
    seen.add(item.key)
    return true
  })
}

// A short primary line for a tool card (the command / file it acts on).
export function toolSummary(_tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.url === 'string') return input.url
  return ''
}
