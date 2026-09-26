// A Claude session's token and cost totals, kept across runs.
//
// Claude Code counts per process: the `result` that ends a turn carries the
// process's running totals, not the turn's. A new run is a new process, which
// starts from zero — unless it is resuming the session the project last ran,
// in which case it picks the previous process's totals back up. Nothing in the
// stream says which happened, so the first result of a run is compared against
// the totals stored from the last one.
//
// Tokens are counted from the API responses themselves, as they arrive, so the
// count moves while a turn is still going. Cost is only known from a result.

import type { Usage } from '../../../shared/agents'
import type { ProcessTotals, SessionStats, StartingStats } from '../harness'

/** The usage fields of one Anthropic API response, as the SDK hands them over. */
export interface ResponseUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * How much of the previous process's count a process must be carrying to be
 * taken as having restored it. Side calls this run made that never surface as
 * a response (titles, command checks) are why it is not an exact match.
 */
const RESTORED_SHARE = 0.9

export class ClaudeUsageLedger {
  // This run's API responses by message id. One response can arrive once per
  // content block, each copy with the same usage, so it is kept, not summed.
  private responses = new Map<string, Usage>()
  // What the process had already counted when this run began: the previous
  // process's totals when it restored them, zero when it started over. Unknown
  // until the run's first result.
  private carried: ProcessTotals | null = null
  private cost: number

  constructor(private start: StartingStats) {
    this.cost = start.cost
  }

  /** Counts one API response and returns the session's totals with it. */
  noteResponse(messageId: string, usage: ResponseUsage): SessionStats {
    this.responses.set(messageId, usageOf(usage))
    return this.totals()
  }

  /**
   * Settles the cost at a turn's result, from the process totals it carries,
   * and returns the session's totals along with those process totals to store.
   */
  noteResult(processUsage: ResponseUsage, processCost: number): SessionStats {
    const processTotals = { tokens: tokensIn(usageOf(processUsage)), cost: processCost }
    if (this.carried === null) this.carried = this.carriedInto(processTotals)
    this.cost = this.start.cost + Math.max(0, processCost - this.carried.cost)
    return { ...this.totals(), processTotals }
  }

  /**
   * What the process brought with it from before this run. It restored the
   * previous totals exactly when, less what this run's responses account for,
   * it is still carrying (nearly) all of them.
   */
  private carriedInto(processTotals: ProcessTotals): ProcessTotals {
    const previous = this.start.processTotals
    if (!previous || previous.tokens <= 0) return { tokens: 0, cost: 0 }
    const unexplained = processTotals.tokens - tokensIn(this.runUsage())
    if (unexplained >= previous.tokens * RESTORED_SHARE) return previous
    return { tokens: 0, cost: 0 }
  }

  /** The session's totals: what it started the run with, plus this run's responses. */
  private totals(): SessionStats {
    return {
      usage: addUsage(this.start.usage, this.runUsage()),
      cost: this.cost,
      contextWindow: 0
    }
  }

  /** Everything this run's responses used, each response counted once. */
  private runUsage(): Usage {
    let total = emptyUsage()
    for (const usage of this.responses.values()) total = addUsage(total, usage)
    return total
  }
}

/** An API response's usage in grove's shape, missing fields as zero. */
function usageOf(usage: ResponseUsage): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0
  }
}

/** Two usages added field by field. */
function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens
  }
}

/** A usage of nothing. */
function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** Every token of every kind in a usage. */
function tokensIn(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}
