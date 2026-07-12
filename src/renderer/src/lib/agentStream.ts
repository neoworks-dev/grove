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
  // Conversation compaction boundary (Claude's /compact). Everything before it
  // was summarized; `freedTokens` is how much context it reclaimed.
  | { kind: 'compact'; trigger: string; freedTokens: number; key: string }
  | { kind: 'raw'; text: string; key: string }

// Internal plumbing tools the agent uses to run itself — not work the user
// asked for, so their cards and results are hidden from the transcript.
// `ToolSearch` loads deferred tool schemas; `SendMessage` talks to subagents.
const HIDDEN_TOOLS = new Set(['ToolSearch', 'SendMessage'])

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

function parseAssistant(
  event: Record<string, unknown>,
  items: OutputItem[],
  hiddenToolIds: Set<string>
): void {
  const message = event.message as { id?: string; content?: unknown[] } | undefined
  if (!message || !Array.isArray(message.content)) return
  const messageId = message.id || 'assistant'
  message.content.forEach((raw, index) => {
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      items.push({ kind: 'text', text: block.text, key: `${messageId}:${index}` })
    } else if (block.type === 'tool_use') {
      const tool = String(block.name || 'tool')
      const id = String(block.id || `${messageId}:${index}`)
      // Internal plumbing tool: skip the card and remember its id so its
      // result is skipped too.
      if (HIDDEN_TOOLS.has(tool)) {
        hiddenToolIds.add(id)
        return
      }
      items.push({
        kind: 'tool',
        tool,
        input: (block.input as Record<string, unknown>) || {},
        key: id
      })
    }
  })
}

function parseUser(
  event: Record<string, unknown>,
  items: OutputItem[],
  hiddenToolIds: Set<string>
): void {
  const message = event.message as { content?: unknown[] } | undefined
  if (!message || !Array.isArray(message.content)) return
  for (const raw of message.content) {
    const block = raw as Record<string, unknown>
    if (block.type !== 'tool_result') continue
    const toolUseId = String(block.tool_use_id || '')
    if (toolUseId && hiddenToolIds.has(toolUseId)) continue
    items.push({
      kind: 'tool-result',
      text: contentToText(block.content),
      isError: block.is_error === true,
      key: `result:${toolUseId || items.length}`
    })
  }
}

function parseCompactBoundary(
  event: Record<string, unknown>,
  items: OutputItem[],
  index: number
): void {
  const metadata = event.compact_metadata as
    { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined
  const pre = typeof metadata?.pre_tokens === 'number' ? metadata.pre_tokens : 0
  const post = typeof metadata?.post_tokens === 'number' ? metadata.post_tokens : 0
  items.push({
    kind: 'compact',
    trigger: String(metadata?.trigger || 'manual'),
    freedTokens: Math.max(0, pre - post),
    key: `compact:${index}`
  })
}

export function parseAgentLines(lines: string[]): OutputItem[] {
  const items: OutputItem[] = []
  // tool_use ids of hidden plumbing tools, so their tool_results are skipped
  // too. A tool_use always precedes its result in the stream.
  const hiddenToolIds = new Set<string>()
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) {
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>
        if (event.type === 'user_prompt') {
          // Synthetic event the manager emits so the user's own prompt shows in
          // the transcript as a chat message.
          items.push({ kind: 'user', text: String(event.text ?? ''), key: `prompt:${index}` })
        } else if (event.type === 'assistant') parseAssistant(event, items, hiddenToolIds)
        else if (event.type === 'user') parseUser(event, items, hiddenToolIds)
        else if (event.type === 'system' && event.subtype === 'compact_boundary') {
          parseCompactBoundary(event, items, index)
        }
        // Other 'system' and 'result' events are control/summary noise — the
        // result text merely repeats the last assistant message, so we drop them.
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

// Matches Claude Code's statusline accounting: point-in-time context fill from
// the LATEST main-conversation API response — fresh input plus cache writes
// plus cache reads — and that response's output. Not cumulative spend.
// Subagent turns (parent_tool_use_id) run in their own context windows, so
// their usage never counts toward the main gauge; the terminal result event
// carries run totals, not a context snapshot, so it's skipped too.
export function parseAgentMeta(lines: string[]): AgentMeta {
  let inputTokens = 0
  let outputTokens = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      if (event.type !== 'assistant') continue
      if (event.parent_tool_use_id) continue
      const usage = usageOf(event)
      if (!usage) continue
      const turnInput =
        num(usage.input_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens)
      // Zero-input events are synthetic (local command output) — keep the last
      // real API response instead.
      if (turnInput === 0) continue
      inputTokens = turnInput
      outputTokens = num(usage.output_tokens)
    } catch {
      // ignore non-JSON lines
    }
  }
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
