// Who else is working here, and how to reach them.
//
// grove's inter-agent tools need three things the session store alone does not
// give them: a readable name per session (the model cannot address a UUID), a
// way to put a message into another session's turn, and a way to start a new
// session on any mounted harness. All three are session-service operations, so
// this is the one place that knows both vocabularies.
//
// Names are session titles. Two sessions may carry the same title, so a
// duplicate is disambiguated with the head of its id — stable for as long as the
// session exists, which is as long as anyone can address it.

import type { SessionMeta } from '../../shared/agents'
import { PARENT_LABEL } from './handoffBridge'
import type { HarnessRegistry } from './harness'
import type { AgentService } from './service'

export interface AgentPeer {
  sessionId: string
  /** What other agents address this session as. */
  name: string
  harness: string
  model: string
  status: SessionMeta['status']
  /** Parked on a tool approval, so it is not going to answer until that is decided. */
  waiting: boolean
}

export interface SpawnOptions {
  workspaceRoot: string
  title: string
  /** The harness to run it on; the session default when left out. */
  harness?: string
  model?: string
  /** The first thing the new agent is told. */
  prompt: string
  /** The session that asked for it; its closing words are reported back there. */
  parentSessionId: string
}

export interface AgentRosterOptions {
  agents: AgentService
  harnesses: HarnessRegistry
}

export class AgentRoster {
  constructor(private options: AgentRosterOptions) {}

  /** Every session rooted in a worktree, named. */
  async peers(workspaceRoot: string): Promise<AgentPeer[]> {
    const sessions = await this.options.agents.listSessions()
    const here = sessions.filter((session) => session.workspaceRoot === workspaceRoot)
    return here.map((session) => this.peerOf(session, here))
  }

  /** The name one session is known by, for signing its own messages. */
  async nameOf(sessionId: string): Promise<string> {
    const sessions = await this.options.agents.listSessions()
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session) return sessionId.slice(0, 8)
    const siblings = sessions.filter((entry) => entry.workspaceRoot === session.workspaceRoot)
    return this.peerOf(session, siblings).name
  }

  /**
   * The peer an agent meant, by name or by session id. Matching is
   * case-insensitive and ignores the disambiguating suffix, because a model that
   * read "Reviewer #a31f0c2b" off the roster will write "Reviewer" as often as not.
   */
  async resolve(workspaceRoot: string, reference: string): Promise<AgentPeer | null> {
    const wanted = reference.trim().toLowerCase()
    if (wanted.length === 0) return null
    const peers = await this.peers(workspaceRoot)

    const byId = peers.find((peer) => peer.sessionId === reference)
    if (byId) return byId
    const byName = peers.find((peer) => peer.name.toLowerCase() === wanted)
    if (byName) return byName
    const byTitle = peers.find((peer) => peer.name.toLowerCase().startsWith(`${wanted} #`))
    if (byTitle) return byTitle
    return null
  }

  /**
   * Put a message into another session.
   *
   * It arrives as an app message rather than a user one, so the transcript keeps
   * saying who is talking, and steers: a peer already mid-turn should hear this
   * now rather than after it has finished the work the message is about.
   */
  async deliver(sessionId: string, from: string, text: string): Promise<void> {
    await this.options.agents.send(sessionId, [
      { type: 'app.message', label: `Message from ${from}`, text, deliverAs: 'steer' }
    ])
  }

  /** Start a new session in the same worktree and give it its first instruction. */
  async spawn(options: SpawnOptions): Promise<AgentPeer> {
    const snapshot = await this.options.agents.createSession({
      workspace: options.workspaceRoot,
      title: options.title,
      harness: options.harness,
      model: options.model,
      labels: { [PARENT_LABEL]: options.parentSessionId }
    })
    await this.options.agents.send(snapshot.id, [
      { type: 'app.message', label: 'Task', text: options.prompt, deliverAs: 'followUp' }
    ])
    const peers = await this.peers(options.workspaceRoot)
    const spawned = peers.find((peer) => peer.sessionId === snapshot.id)
    if (spawned) return spawned
    return {
      sessionId: snapshot.id,
      name: options.title,
      harness: snapshot.harness,
      model: snapshot.model,
      status: snapshot.status,
      waiting: false
    }
  }

  /** The harnesses a spawned agent may run on. */
  harnessIds(): string[] {
    return this.options.harnesses.ids()
  }

  private peerOf(session: SessionMeta, siblings: SessionMeta[]): AgentPeer {
    return {
      sessionId: session.id,
      name: nameFor(session, siblings),
      harness: session.harness,
      model: session.model,
      status: session.status,
      waiting: session.pendingApprovals.length > 0
    }
  }
}

/** A session's title, kept unique among the sessions it shares a worktree with. */
function nameFor(session: SessionMeta, siblings: SessionMeta[]): string {
  const title = session.title.trim() || session.harness
  const shared = siblings.filter((entry) => (entry.title.trim() || entry.harness) === title)
  if (shared.length < 2) return title
  return `${title} #${session.id.slice(0, 8)}`
}
