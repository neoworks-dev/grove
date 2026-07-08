// Parses agent output lines into renderable items. Claude's `--output-format
// stream-json` emits one complete JSON event per line; we extract assistant
// text, tool calls (rendered as command cards), and tool results. Non-JSON
// lines (other agents, or stderr) pass through as raw text. Items are keyed so
// re-parsing an appended log never produces visual duplicates.

export type OutputItem =
  | { kind: 'user'; text: string; key: string }
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
        if (event.type === 'user_prompt') {
          // Synthetic event the manager emits so the user's own prompt shows in
          // the transcript as a chat message.
          items.push({ kind: 'user', text: String(event.text ?? ''), key: `prompt:${index}` })
        } else if (event.type === 'assistant') parseAssistant(event, items)
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

// ── Token accounting ────────────────────────────────────────────
// Cumulative input/output token usage across the run, read from the `usage`
// block that assistant and result events carry (SDK stream-json shape).
export interface AgentMeta {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

function usageOf(event: Record<string, unknown>): Record<string, unknown> | null {
  const message = event.message as { usage?: Record<string, unknown> } | undefined
  if (message?.usage) return message.usage
  if (event.usage && typeof event.usage === 'object') return event.usage as Record<string, unknown>
  return null
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

export function parseAgentMeta(lines: string[]): AgentMeta {
  let inputTokens = 0
  let assistantOutput = 0 // summed across streamed assistant turns
  let resultOutput = 0 // authoritative total from the terminal result event
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      const usage = usageOf(event)
      if (!usage) continue
      // Input includes cache reads; take the largest turn seen.
      const turnInput =
        num(usage.input_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens)
      inputTokens = Math.max(inputTokens, turnInput)
      if (event.type === 'result') resultOutput = num(usage.output_tokens)
      else assistantOutput += num(usage.output_tokens)
    } catch {
      // ignore non-JSON lines
    }
  }
  // The result event's total supersedes the running sum once the run finishes.
  const outputTokens = Math.max(assistantOutput, resultOutput)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
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
