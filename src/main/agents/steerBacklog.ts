// Steered messages the model has not taken up yet.
//
// A steer is handed to the harness mid-turn and reaches the model with the
// next request the agent makes. A turn that is interrupted before then ends
// with the steer still waiting, and harnesses drop it on cancel — so the
// service keeps them here and, when a turn is stopped, starts the next one
// with whatever never arrived. The rule for "taken" matches the transcript's
// (see `openAgentItem` in the renderer): a new agent message is a new request,
// and that request carries everything written to it so far.

import type { ServerEventBody } from '../../shared/agents'

/** A steered message, kept with what is needed to send it again as a prompt. */
export interface SteeredMessage<Attachment> {
  id: string
  text: string
  attachments: Attachment[]
}

export class SteerBacklog<Attachment> {
  private waiting: SteeredMessage<Attachment>[] = []
  // The agent message being streamed, so its later chunks are not mistaken for
  // a new request. False once anything else (a tool call) comes in between.
  private agentMessageOpen = false
  private agentMessageId: string | null = null

  /** Records a message just steered into the running turn. */
  add(message: SteeredMessage<Attachment>): void {
    this.waiting = [...this.waiting, message]
  }

  /** Forgets one waiting message; says whether it was still waiting. */
  remove(id: string): boolean {
    const before = this.waiting.length
    this.waiting = this.waiting.filter((message) => message.id !== id)
    return this.waiting.length < before
  }

  /** Follows the harness's output to notice when the model has taken the waiting messages. */
  observe(body: ServerEventBody): void {
    if (body.type !== 'update') {
      return
    }
    const update = body.update
    const isChunk =
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    if (!isChunk) {
      if (update.sessionUpdate === 'tool_call') {
        this.agentMessageOpen = false
      }
      return
    }
    const messageId = update.messageId ?? null
    if (this.startsNewMessage(messageId)) {
      this.waiting = []
    }
    this.agentMessageOpen = true
    if (messageId !== null) {
      this.agentMessageId = messageId
    }
  }

  /** Hands back the messages that never reached the model, and forgets them. */
  take(): SteeredMessage<Attachment>[] {
    const untaken = this.waiting
    this.reset()
    return untaken
  }

  /** Forgets everything, e.g. once a turn has ended normally. */
  reset(): void {
    this.waiting = []
    this.agentMessageOpen = false
    this.agentMessageId = null
  }

  /** Whether a chunk under this id opens a new agent message rather than continuing one. */
  private startsNewMessage(messageId: string | null): boolean {
    if (!this.agentMessageOpen) {
      return true
    }
    if (messageId === null || this.agentMessageId === null) {
      return false
    }
    return messageId !== this.agentMessageId
  }
}
