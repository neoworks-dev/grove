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
//
// A response's output count is only final in its stream's `message_delta`: the
// assistant messages the SDK hands over carry the usage `message_start` had,
// with a handful of output tokens, so counting from those alone misses nearly
// all of the output.

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
  // The response each stream is in the middle of, by the tool call running it
  // (the main conversation's stream has none). `message_delta` names no id.
  private streaming = new Map<string, string>()
  // The main conversation's latest response, whole: what its context now holds.
  private contextTokens = 0
  private contextWindow: number

  constructor(private start: StartingStats) {
    this.cost = start.cost
    this.contextWindow = start.contextWindow
  }

  /**
   * Counts one API response and returns the session's totals with it. A
   * response reported again keeps the larger of each count, as its output
   * only grows while it streams.
   */
  noteResponse(messageId: string, usage: ResponseUsage): SessionStats {
    const counted = this.responses.get(messageId)
    let next = usageOf(usage)
    if (counted) next = largerOf(counted, next)
    this.responses.set(messageId, next)
    return this.totals()
  }

  /**
   * Counts the usage a raw stream event carries, or returns null when it
   * carries none: `message_start` opens a response, and its `message_delta`
   * brings the final output count.
   */
  noteStreamEvent(lane: string, rawEvent: unknown): SessionStats | null {
    const event = rawEvent as StreamUsageEvent
    if (event.type === 'message_start' && event.message?.id) {
      this.streaming.set(lane, event.message.id)
      if (!event.message.usage) return null
      return this.noteLaneResponse(lane, event.message.id, event.message.usage)
    }
    if (event.type !== 'message_delta' || !event.usage) return null
    const messageId = this.streaming.get(lane)
    if (!messageId) return null
    return this.noteLaneResponse(lane, messageId, event.usage)
  }

  /**
   * Counts a streamed response. One in the main conversation (lane '') is
   * also how full its context now is; a subagent's has a context of its own.
   */
  private noteLaneResponse(lane: string, messageId: string, usage: ResponseUsage): SessionStats {
    this.noteResponse(messageId, usage)
    const counted = this.responses.get(messageId)
    if (lane === '' && counted) this.contextTokens = tokensIn(counted)
    return this.totals()
  }

  /**
   * Settles the cost at a turn's result, from the process totals it carries,
   * and returns the session's totals along with those process totals to store.
   */
  noteResult(
    processUsage: ResponseUsage,
    processCost: number,
    contextWindow: number | null = null
  ): SessionStats {
    if (contextWindow !== null && contextWindow > 0) this.contextWindow = contextWindow
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
    const stats: SessionStats = {
      usage: addUsage(this.start.usage, this.runUsage()),
      cost: this.cost,
      contextWindow: this.contextWindow
    }
    // Not reported until this run has seen a response, so a resumed session
    // keeps the context it last showed.
    if (this.contextTokens > 0) stats.contextTokens = this.contextTokens
    return stats
  }

  /** Everything this run's responses used, each response counted once. */
  private runUsage(): Usage {
    let total = emptyUsage()
    for (const usage of this.responses.values()) total = addUsage(total, usage)
    return total
  }
}

/**
 * The largest context window among the models a result says the run used —
 * the conversation's own model, beside side calls made on smaller ones.
 */
export function contextWindowOf(
  modelUsage: Record<string, { contextWindow?: number }> | undefined
): number | null {
  if (!modelUsage) return null
  let largest = 0
  for (const usage of Object.values(modelUsage)) {
    if (typeof usage.contextWindow === 'number' && usage.contextWindow > largest) {
      largest = usage.contextWindow
    }
  }
  if (largest === 0) return null
  return largest
}

/** The parts of a raw stream event that carry usage. */
interface StreamUsageEvent {
  type: string
  message?: { id?: string; usage?: ResponseUsage }
  usage?: ResponseUsage
}

/** Each count the larger of the two. */
function largerOf(left: Usage, right: Usage): Usage {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens)
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
