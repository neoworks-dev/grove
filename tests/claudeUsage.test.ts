// A Claude session's token and cost totals, across turns and across runs.
//
// Claude Code's results carry its process's running totals. The ledger has to
// add a run onto what the session already had, whether the new process began
// its count from zero or picked the previous process's totals back up.

import { describe, expect, test } from 'bun:test'
import { ClaudeUsageLedger, contextWindowOf } from '../src/main/agents/harnesses/claudeUsage'
import type { StartingStats } from '../src/main/agents/harness'

const NOTHING: StartingStats = {
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: 0,
  contextWindow: 0,
  processTotals: null
}

/** A session that has already used 1000 tokens and $1, all in one earlier process. */
const EARLIER: StartingStats = {
  usage: { inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: 1,
  contextWindow: 0,
  processTotals: { tokens: 1000, cost: 1 }
}

describe('ClaudeUsageLedger', () => {
  test('counts tokens as each response arrives, before the turn ends', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteResponse('msg-1', { input_tokens: 10, output_tokens: 5 })
    const totals = ledger.noteResponse('msg-2', { input_tokens: 20, output_tokens: 7 })

    expect(totals.usage.inputTokens).toBe(30)
    expect(totals.usage.outputTokens).toBe(12)
  })

  test('counts a response once, however many of its blocks arrive', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteResponse('msg-1', { input_tokens: 10, output_tokens: 5 })
    const totals = ledger.noteResponse('msg-1', { input_tokens: 10, output_tokens: 5 })

    expect(totals.usage.inputTokens).toBe(10)
  })

  test('adds a run onto what the session had, instead of replacing it', () => {
    const ledger = new ClaudeUsageLedger(EARLIER)

    const totals = ledger.noteResponse('msg-1', { input_tokens: 50, output_tokens: 50 })

    expect(totals.usage.inputTokens).toBe(650)
    expect(totals.usage.outputTokens).toBe(450)
  })

  test('takes the cost of later turns in the same run as growth of the process total', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteResponse('msg-1', { input_tokens: 100 })
    ledger.noteResult({ input_tokens: 100 }, 0.5)
    ledger.noteResponse('msg-2', { input_tokens: 100 })
    const totals = ledger.noteResult({ input_tokens: 200 }, 0.8)

    expect(totals.cost).toBeCloseTo(0.8)
    expect(totals.processTotals).toEqual({ tokens: 200, cost: 0.8 })
  })

  test('a process that started from zero adds all of its cost', () => {
    const ledger = new ClaudeUsageLedger(EARLIER)

    ledger.noteResponse('msg-1', { input_tokens: 100 })
    const totals = ledger.noteResult({ input_tokens: 100 }, 0.25)

    expect(totals.cost).toBeCloseTo(1.25)
  })

  test('a process that restored the previous totals adds only what is new', () => {
    const ledger = new ClaudeUsageLedger(EARLIER)

    ledger.noteResponse('msg-1', { input_tokens: 100 })
    // The process reports the earlier 1000 tokens and $1 on top of this run's.
    const totals = ledger.noteResult({ input_tokens: 1100 }, 1.25)

    expect(totals.cost).toBeCloseTo(1.25)
    expect(totals.usage.inputTokens).toBe(700)
  })

  test('side calls that never surface as responses do not read as a restore', () => {
    const ledger = new ClaudeUsageLedger(EARLIER)

    ledger.noteResponse('msg-1', { input_tokens: 100 })
    // 50 tokens of titles and command checks, far short of the earlier 1000.
    const totals = ledger.noteResult({ input_tokens: 150 }, 0.3)

    expect(totals.cost).toBeCloseTo(1.3)
  })
})

// The SDK's assistant messages carry the usage from `message_start`, with a
// handful of output tokens; the real output count only arrives in the stream's
// `message_delta` (#136). Shapes as a real Haiku response streamed them.
describe('ClaudeUsageLedger reading the stream', () => {
  const startUsage = { input_tokens: 10, cache_creation_input_tokens: 4097, output_tokens: 4 }
  const deltaUsage = { ...startUsage, output_tokens: 339 }

  test("counts a response's final output from its message_delta", () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteStreamEvent('', { type: 'message_start', message: { id: 'msg-1', usage: startUsage } })
    ledger.noteResponse('msg-1', startUsage)
    const totals = ledger.noteStreamEvent('', { type: 'message_delta', usage: deltaUsage })

    expect(totals?.usage.outputTokens).toBe(339)
    expect(totals?.usage.cacheWriteTokens).toBe(4097)
  })

  test('an assistant message arriving after the delta does not undo it', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteStreamEvent('', { type: 'message_start', message: { id: 'msg-1', usage: startUsage } })
    ledger.noteStreamEvent('', { type: 'message_delta', usage: deltaUsage })
    const totals = ledger.noteResponse('msg-1', startUsage)

    expect(totals.usage.outputTokens).toBe(339)
  })

  test('keeps streams run by different tool calls apart', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteStreamEvent('', { type: 'message_start', message: { id: 'main', usage: startUsage } })
    ledger.noteStreamEvent('call-1', {
      type: 'message_start',
      message: { id: 'sub', usage: startUsage }
    })
    ledger.noteStreamEvent('', { type: 'message_delta', usage: { output_tokens: 100 } })
    const totals = ledger.noteStreamEvent('call-1', {
      type: 'message_delta',
      usage: { output_tokens: 50 }
    })

    expect(totals?.usage.outputTokens).toBe(150)
  })

  test('ignores events that carry no usage', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)
    expect(ledger.noteStreamEvent('', { type: 'content_block_delta' })).toBeNull()
  })
})

// How full the context is: the latest response's whole prompt — system prompt
// and cached turns, which are nearly all of it — plus its output. Counting only
// uncached input and output left the pane near zero for a whole session.
describe('ClaudeUsageLedger measuring the context', () => {
  test("is the main conversation's latest response, cache included", () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteStreamEvent('', {
      type: 'message_start',
      message: {
        id: 'msg-1',
        usage: { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 }
      }
    })
    const totals = ledger.noteStreamEvent('', { type: 'message_delta', usage: { output_tokens: 300 } })

    expect(totals?.contextTokens).toBe(20810)
  })

  test('is not summed across responses', () => {
    const ledger = new ClaudeUsageLedger(NOTHING)
    const usage = { input_tokens: 10, cache_read_input_tokens: 20000 }

    ledger.noteStreamEvent('', { type: 'message_start', message: { id: 'msg-1', usage } })
    const totals = ledger.noteStreamEvent('', { type: 'message_start', message: { id: 'msg-2', usage } })

    expect(totals?.contextTokens).toBe(20010)
  })

  test("leaves out a subagent's own context", () => {
    const ledger = new ClaudeUsageLedger(NOTHING)

    ledger.noteStreamEvent('', {
      type: 'message_start',
      message: { id: 'main', usage: { input_tokens: 100 } }
    })
    const totals = ledger.noteStreamEvent('call-1', {
      type: 'message_start',
      message: { id: 'sub', usage: { input_tokens: 9000 } }
    })

    expect(totals?.contextTokens).toBe(100)
  })

  test('takes the window from the result, and keeps it from the last run', () => {
    const ledger = new ClaudeUsageLedger({ ...NOTHING, contextWindow: 200000 })
    expect(ledger.noteResponse('msg-1', { input_tokens: 1 }).contextWindow).toBe(200000)

    const totals = ledger.noteResult({ input_tokens: 1 }, 0.1, 1000000)
    expect(totals.contextWindow).toBe(1000000)
  })

  test("reads the conversation model's window from a result's model usage", () => {
    const modelUsage = {
      'claude-opus-5-5': { contextWindow: 1000000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200000 }
    }
    expect(contextWindowOf(modelUsage)).toBe(1000000)
    expect(contextWindowOf({})).toBeNull()
    expect(contextWindowOf(undefined)).toBeNull()
  })
})
