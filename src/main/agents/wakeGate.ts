// Agent messages that would wake a long-idle session wait for the user.
//
// `send_message` and a spawned agent's report both put a message into another
// session, and a message to an idle session starts a turn there. When that
// session has slept past its prompt cache (heldMessages.ts), the turn re-reads
// its whole context uncached — usage spent because some other agent spoke,
// often on something the sleeping session no longer needs to hear. So such a
// message is put on the session's log as held instead, with what waking would
// cost, and the user decides: send it, compact the context first and then send
// it, or drop it.
//
// The decision arrives as a `user.decide_held_message` on the same log, which
// this gate follows and acts on. The sender is told it was held when it sends,
// and how the user decided once they have — unless the sender has gone to sleep
// itself by then, since waking it only to hear that would be the same waste.

import { randomUUID } from 'node:crypto'
import type {
  ClientEventBody,
  HeldMessage,
  HeldMessageDecision,
  ModelPricing,
  SessionEvent,
  SessionMeta
} from '../../shared/agents'
import { loadModelCatalog } from '../modelCatalog'
import { decidedBefore, heldMessageNamed, sleepingSince, wakeCostOf } from './heldMessages'
import { signatureOfSession } from './roster'
import type { AgentService } from './service'
import type { SessionStore } from './store'

export interface WakeGateOptions {
  agents: Pick<AgentService, 'listSessions' | 'listEvents' | 'getSession' | 'send' | 'catalog'>
  store: Pick<SessionStore, 'subscribe'>
  /** What a model costs, for the price of waking a session that runs on it. */
  pricing: (provider: string, model: string) => Promise<ModelPricing | null>
  log: (line: string) => void
  now?: () => number
}

/** What became of a message: in the session now, or waiting for the user. */
export type DeliveryOutcome = { kind: 'delivered' } | { kind: 'held'; idleSince: string }

export class WakeGate {
  private now: () => number

  constructor(private options: WakeGateOptions) {
    this.now = options.now ?? ((): number => Date.now())
  }

  /**
   * Put an agent's message into a session, or hold it when delivering would
   * wake a session that has slept past its prompt cache.
   */
  async deliver(
    sessionId: string,
    from: string,
    text: string,
    fromSessionId: string | null
  ): Promise<DeliveryOutcome> {
    const session = await this.sessionNamed(sessionId)
    const events = await this.options.agents.listEvents(sessionId)
    let idleSince: string | null = null
    if (session) idleSince = sleepingSince(session, events, this.now())
    if (!session || !idleSince) {
      await this.options.agents.send(sessionId, [agentMessage(from, text, 'steer')])
      return { kind: 'delivered' }
    }

    const held = await this.heldMessage(session, { from, fromSessionId, text, idleSince })
    await this.options.agents.send(sessionId, [{ type: 'app.held_message', ...held }])
    return { kind: 'held', idleSince }
  }

  /** Follow the logs for the user's decisions. Returns the inverse. */
  watch(): () => void {
    return this.options.store.subscribe((event) => {
      if (event.type !== 'user.decide_held_message') return
      void this.decide(event).catch((error: Error) =>
        this.options.log(`wake gate: acting on a held message failed: ${error.message}`)
      )
    })
  }

  /** Carry out the user's answer to a held message, once. */
  private async decide(event: Extract<SessionEvent, { type: 'user.decide_held_message' }>): Promise<void> {
    const events = await this.options.agents.listEvents(event.sessionId)
    if (decidedBefore(events, event.heldId, event.seq)) return
    const held = heldMessageNamed(events, event.heldId)
    if (!held) return

    await this.carryOut(event.sessionId, held, event.decision)
    await this.tellSender(event.sessionId, held, event.decision)
  }

  private async carryOut(sessionId: string, held: HeldMessage, decision: HeldMessageDecision): Promise<void> {
    if (decision === 'reject') return
    if (decision === 'send') {
      await this.options.agents.send(sessionId, [agentMessage(held.from, held.text, 'steer')])
      return
    }
    // The compaction is a turn of its own; the message follows it, so the
    // model reads it against the compacted context rather than the full one.
    await this.options.agents.send(sessionId, [
      { type: 'user.command', name: 'compact', args: '' },
      agentMessage(held.from, held.text, 'followUp')
    ])
  }

  /**
   * Tell the sender how the user decided, if it is still awake to hear it. One
   * that has slept past its own cache since is left asleep.
   */
  private async tellSender(sessionId: string, held: HeldMessage, decision: HeldMessageDecision): Promise<void> {
    if (!held.fromSessionId || held.fromSessionId === sessionId) return
    const sender = await this.sessionNamed(held.fromSessionId)
    if (!sender) return
    const senderEvents = await this.options.agents.listEvents(sender.id)
    if (sleepingSince(sender, senderEvents, this.now())) return

    const recipient = await this.sessionNamed(sessionId)
    let name = sessionId.slice(0, 8)
    if (recipient) name = signatureOfSession(recipient)
    await this.options.agents.send(sender.id, [
      { type: 'app.message', label: 'Held message', text: decisionNotice(name, decision), deliverAs: 'followUp' }
    ])
  }

  /** The held message as recorded: who sent what, and what waking the session would take. */
  private async heldMessage(
    session: SessionMeta,
    message: { from: string; fromSessionId: string | null; text: string; idleSince: string }
  ): Promise<HeldMessage> {
    const snapshot = await this.options.agents.getSession(session.id)
    const contextTokens = snapshot.context.usedTokens
    const pricing = await this.options.pricing(session.provider, session.model).catch(() => null)
    return {
      heldId: randomUUID(),
      ...message,
      contextTokens,
      wakeCost: wakeCostOf(contextTokens, pricing),
      canCompact: await this.offersCompact(session.harness)
    }
  }

  /** Whether the harness lists `/compact` among its commands. */
  private async offersCompact(harness: string): Promise<boolean> {
    const catalog = await this.options.agents.catalog(harness).catch(() => null)
    if (!catalog) return false
    return catalog.commands.some((command) => command.name === 'compact')
  }

  private async sessionNamed(sessionId: string): Promise<SessionMeta | undefined> {
    const sessions = await this.options.agents.listSessions()
    return sessions.find((session) => session.id === sessionId)
  }
}

/** A message from another agent, as the session receives one. */
function agentMessage(from: string, text: string, deliverAs: 'steer' | 'followUp'): ClientEventBody {
  return { type: 'app.message', label: 'Agent message', from, text, deliverAs }
}

/** What the sender hears once the user has decided. */
function decisionNotice(recipient: string, decision: HeldMessageDecision): string {
  if (decision === 'send') return `The user delivered your message to ${recipient}.`
  if (decision === 'compact_then_send') {
    return `The user compacted ${recipient}'s context and then delivered your message.`
  }
  return `The user declined to deliver your message to ${recipient}; it was not woken for it. Do not send it again.`
}

/** A model's price from the public catalog, when the catalog lists that provider and model. */
export async function catalogPricing(provider: string, model: string): Promise<ModelPricing | null> {
  const providers = await loadModelCatalog()
  const entry = providers.find((candidate) => candidate.id === provider)
  if (!entry) return null
  const listed = entry.models.find((candidate) => candidate.id === model)
  if (!listed) return null
  return listed.pricing
}
