import { describe, it, expect } from 'bun:test'
import { parseAgentLines, parseAgentMeta, toolSummary } from '../src/renderer/src/lib/agentStream'

function assistant(content: unknown[], id = 'msg_1', usage?: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content, ...(usage ? { usage } : {}) }
  })
}

describe('parseAgentLines', () => {
  it('extracts assistant text', () => {
    const items = parseAgentLines([assistant([{ type: 'text', text: 'hello' }])])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'text', text: 'hello' })
  })

  it('extracts tool calls with input', () => {
    const items = parseAgentLines([
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }])
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', tool: 'Bash' })
    expect(toolSummary('Bash', (items[0] as { input: Record<string, unknown> }).input)).toBe(
      'ls -la'
    )
  })

  it('drops system and result events (result repeats assistant text)', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude' }),
      assistant([{ type: 'text', text: 'answer' }]),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'answer' })
    ]
    const items = parseAgentLines(lines)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'text', text: 'answer' })
  })

  it('deduplicates repeated events by key', () => {
    const line = assistant([{ type: 'text', text: 'once' }])
    const items = parseAgentLines([line, line, line])
    expect(items).toHaveLength(1)
  })

  it('renders tool results, flagging errors', () => {
    const items = parseAgentLines([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }]
        }
      })
    ])
    expect(items[0]).toMatchObject({ kind: 'tool-result', text: 'boom', isError: true })
  })

  it('passes non-JSON lines through as raw', () => {
    const items = parseAgentLines(['plain stderr line'])
    expect(items[0]).toMatchObject({ kind: 'raw', text: 'plain stderr line' })
  })

  it('reads tool_result content given as blocks', () => {
    const items = parseAgentLines([
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'blocktext' }] }
          ]
        }
      })
    ])
    expect(items[0]).toMatchObject({ kind: 'tool-result', text: 'blocktext' })
  })

  it('surfaces the user prompt as a user message', () => {
    const items = parseAgentLines([JSON.stringify({ type: 'user_prompt', text: 'fix the bug' })])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'fix the bug' })
  })
})

describe('parseAgentMeta', () => {
  it('sums output tokens across turns and takes the largest input', () => {
    const meta = parseAgentMeta([
      assistant([{ type: 'text', text: 'a' }], 'm1', { input_tokens: 100, output_tokens: 20 }),
      assistant([{ type: 'text', text: 'b' }], 'm2', { input_tokens: 140, output_tokens: 30 })
    ])
    expect(meta.inputTokens).toBe(140)
    expect(meta.outputTokens).toBe(50)
    expect(meta.totalTokens).toBe(190)
  })

  it('counts cache reads toward input and lets the result total win', () => {
    const meta = parseAgentMeta([
      assistant([{ type: 'text', text: 'a' }], 'm1', {
        input_tokens: 10,
        cache_read_input_tokens: 90,
        output_tokens: 15
      }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 40 } })
    ])
    expect(meta.inputTokens).toBe(100)
    expect(meta.outputTokens).toBe(40) // result total supersedes the running sum
  })

  it('returns zeros when no usage is present', () => {
    const meta = parseAgentMeta([assistant([{ type: 'text', text: 'a' }])])
    expect(meta).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })
})
