// A Claude session's token and cost totals, across turns and across runs.
//
// Claude Code's results carry its process's running totals. The ledger has to
// add a run onto what the session already had, whether the new process began
// its count from zero or picked the previous process's totals back up.

import { describe, expect, test } from 'bun:test'
import { ClaudeUsageLedger } from '../src/main/agents/harnesses/claudeUsage'
import type { StartingStats } from '../src/main/agents/harness'

const NOTHING: StartingStats = {
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: 0,
  processTotals: null
}

/** A session that has already used 1000 tokens and $1, all in one earlier process. */
const EARLIER: StartingStats = {
  usage: { inputTokens: 600, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: 1,
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
