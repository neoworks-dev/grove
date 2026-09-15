// Who else is working here, and how to reach them.
//
// grove's inter-agent tools need three things the session store alone does not
// give them: an address per session, a way to put a message into another
// session's turn, and a way to start a new session on any mounted harness. All
// three are session-service operations, so this is the one place that knows both
// vocabularies.
//
// The address is the session's agent id, not its title: titles are edited and
// duplicated, and an address that moved when a user renamed a tab would strand
// every agent holding it. Titles still travel alongside, because "auth-refactor"
// is what makes a roster readable.

import type { HarnessInfo, SessionMeta } from '../../shared/agents'
import { DISPOSE_LABEL, PARENT_LABEL } from './handoffBridge'
import type { HarnessRegistry } from './harness'
import { agentIdOf } from './identity'
import type { AgentService } from './service'

export interface AgentPeer {
  sessionId: string
  /** What other agents address this session as. Stable for the session's life. */
  agentId: string
  /** The session's title, for reading rather than addressing. */
  title: string
  harness: string
  model: string
  status: SessionMeta['status']
  /** Parked on a tool approval, so it is not going to answer until that is decided. */
  waiting: boolean
}

/** A runtime a spawned agent can be put on, and what it can be run with. */
export interface AgentRuntime {
  id: string
  label: string
  /** Installed and authenticated: a runtime that is not cannot be spawned onto. */
  available: boolean
  detail: string | null
  /** Can it host grove's tools? One that cannot can be given work but cannot answer. */
  talks: boolean
  models: RuntimeModel[]
  default: RuntimeModel | null
}

export interface RuntimeModel {
  provider: string
  model: string
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
  /** Remove the session once it has reported back, rather than leaving it open. */
  removeWhenDone?: boolean
}

export interface AgentRosterOptions {
  agents: AgentService
  harnesses: HarnessRegistry
}

export class AgentRoster {
  constructor(private options: AgentRosterOptions) {}

  /** Every session rooted in a worktree, with the id each is addressed by. */
  async peers(workspaceRoot: string): Promise<AgentPeer[]> {
    const sessions = await this.options.agents.listSessions()
    return sessions
      .filter((session) => session.workspaceRoot === workspaceRoot)
      .map((session) => peerOf(session))
  }

  /** How one session signs its own messages: "title (id)", or the id alone. */
  async signatureOf(sessionId: string): Promise<string> {
    const sessions = await this.options.agents.listSessions()
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session) return sessionId.slice(0, 8)
    return signatureOf(peerOf(session))
  }

  /** The agent id of one session. */
  async agentIdOf(sessionId: string): Promise<string> {
    const sessions = await this.options.agents.listSessions()
    const session = sessions.find((entry) => entry.id === sessionId)
    if (!session) return sessionId.slice(0, 8)
    return agentIdOf(session)
  }

  /**
   * The peer an agent meant.
   *
   * An agent id is the address, so that is matched first. A title is accepted
   * too — a model that has read one off the roster will use it — but only when
   * exactly one session carries it, since a title says nothing about which.
   */
  async resolve(workspaceRoot: string, reference: string): Promise<AgentPeer | null> {
    const wanted = reference.trim().toLowerCase()
    if (wanted.length === 0) return null
    const peers = await this.peers(workspaceRoot)

    const byAgentId = peers.find((peer) => peer.agentId.toLowerCase() === wanted)
    if (byAgentId) return byAgentId
    const bySessionId = peers.find((peer) => peer.sessionId === reference)
    if (bySessionId) return bySessionId

    const byTitle = peers.filter((peer) => peer.title.trim().toLowerCase() === wanted)
    if (byTitle.length === 1) return byTitle[0]
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
      { type: 'app.message', label: 'Agent message', from, text, deliverAs: 'steer' }
    ])
  }

  /** Start a new session in the same worktree and give it its first instruction. */
  async spawn(options: SpawnOptions): Promise<AgentPeer> {
    const snapshot = await this.options.agents.createSession({
      workspace: options.workspaceRoot,
      title: options.title,
      harness: options.harness,
      model: options.model,
      labels: labelsFor(options)
    })
    // The brief is the parent talking, so it arrives as the parent talking: the
    // child's transcript opens on a message from the agent that started it
    // rather than on an unattributed task card.
    const from = await this.signatureOf(options.parentSessionId)
    await this.options.agents.send(snapshot.id, [
      { type: 'app.message', label: 'Task', from, text: options.prompt, deliverAs: 'followUp' }
    ])
    return peerOf(snapshot)
  }

  /** Remove a session and everything it recorded. */
  async dispose(sessionId: string): Promise<void> {
    await this.options.agents.deleteSession(sessionId)
  }

  /** The harnesses a spawned agent may run on. */
  harnessIds(): string[] {
    return this.options.harnesses.ids()
  }

  /**
   * Every runtime and what it can be run with.
   *
   * Asked for on demand rather than built into the tool's description: models
   * come and go with what the user has authenticated, and a list baked in when
   * the session started would be wrong by the time an agent read it.
   */
  async runtimes(): Promise<AgentRuntime[]> {
    const described = await this.options.harnesses.describe()
    return Promise.all(described.map((harness) => this.runtimeOf(harness)))
  }

  /** The runtime one session is running on, for defaulting a spawn to the same. */
  async agentHarnessOf(sessionId: string): Promise<string | null> {
    const sessions = await this.options.agents.listSessions()
    return sessions.find((session) => session.id === sessionId)?.harness ?? null
  }

  /** The models one runtime can be started on; empty when it cannot say. */
  async modelsOf(harnessId: string): Promise<RuntimeModel[]> {
    const catalog = await this.options.agents.catalog(harnessId).catch(() => null)
    if (!catalog) return []
    return catalog.providers.flatMap((entry) =>
      entry.models.map((model) => ({ provider: entry.provider, model: model.id }))
    )
  }

  private async runtimeOf(harness: HarnessInfo): Promise<AgentRuntime> {
    const catalog = await this.options.agents.catalog(harness.id).catch(() => null)
    const models = (catalog?.providers ?? []).flatMap((entry) =>
      entry.models.map((model) => ({ provider: entry.provider, model: model.id }))
    )
    return {
      id: harness.id,
      label: harness.label,
      available: harness.available,
      detail: harness.detail,
      talks: harness.capabilities.groveTools,
      models,
      default: catalog?.default ?? null
    }
  }
}

/** What a spawned session is marked with: who started it, and whether it stays. */
function labelsFor(options: SpawnOptions): Record<string, string> {
  const labels: Record<string, string> = { [PARENT_LABEL]: options.parentSessionId }
  if (options.removeWhenDone) labels[DISPOSE_LABEL] = 'whenDone'
  return labels
}

function peerOf(session: SessionMeta): AgentPeer {
  return {
    sessionId: session.id,
    agentId: agentIdOf(session),
    title: session.title.trim() || session.harness,
    harness: session.harness,
    model: session.model,
    status: session.status,
    waiting: session.pendingApprovals.length > 0
  }
}

/** How a peer is named when it is talking rather than being addressed. */
export function signatureOf(peer: AgentPeer): string {
  return `${peer.title} (${peer.agentId})`
}
