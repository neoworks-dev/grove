// The harness contract and the registry plugins publish into.
//
// A harness is one way of running a coding agent — Claude Code, Codex or pi
// through switchboard, or grove's own mode on top of one of them. Everything
// grove needs from one is here: whether it can run at all, what it can offer
// (models, commands, skills), and how to start and steer one session.
//
// Runs never touch grove's session store. They emit what the harness reported,
// as switchboard reported it, and the store stamps sequence numbers, persists
// the events and fans them out.

import type { RequestPermissionRequest, ToolCallUpdate } from '@neoworks/harness'
import type {
  AgentMode,
  CommandInfo,
  ConfirmationResult,
  DeliverAs,
  HarnessCapabilities,
  HarnessInfo,
  ImageBlock,
  ModelEntry,
  ServerEventBody,
  ShowTarget,
  SkillInfo,
  ThinkingLevel,
  ToolDisplay,
  ToolInfo,
  ToolPolicy,
  Usage
} from '../../shared/agents'
import type { ShellOutputSink } from './shellOutput'

/** What a grove-owned tool needs from the session that called it. */
export interface GroveToolContext {
  sessionId: string
  workspaceRoot: string
  /** Publish a declarative view under a surface id the renderer watches. */
  surface(surfaceId: string, slot: 'transcript' | 'panel', view: unknown): void
  /** Ask the renderer to put something else in front of the user. */
  show(target: ShowTarget): void
  /** The harness's id for this call, when it has reported the call already. */
  toolCallId?: string
  /** Where a tool that runs a command reports what it prints, as it prints it. */
  shellOutput?: ShellOutputSink
  /**
   * Add to what the transcript shows of this call — the diff an edit made —
   * the way a harness reports its own tools. Kept when the call's result comes.
   */
  report?(update: Omit<ToolCallUpdate, 'toolCallId'>): void
}

export interface GroveToolResult {
  content: string
  isError?: boolean
}

/**
 * A tool grove contributes to every harness that can host one: the review
 * protocol, the worktree chat channel, the onboarding stepper. Described once
 * and translated by each adapter into whatever its SDK calls a tool.
 */
export interface GroveTool {
  name: string
  /** One line saying what the tool does: the tool's entry in the system prompt. */
  summary: string
  description: string
  /** Rules the tool adds to the system prompt of a session that has it. */
  promptGuidelines?: string[]
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>
  /** `ask` parks the call until grove answers it; `allow` runs straight away. */
  policy: ToolPolicy
  display?: ToolDisplay
  /**
   * Offer the tool up front on a runtime that otherwise hides tools behind a
   * search. For a tool the model should reach for unprompted: one it has to go
   * looking for first only gets used when the user names it.
   */
  alwaysLoad?: boolean
  /**
   * What a call would do, for its approval to show before it runs: the diff a
   * file edit would make, the kind of call it is.
   */
  describe?(
    input: Record<string, unknown>,
    context: GroveToolContext
  ): Promise<Partial<ToolCallUpdate>>
  execute(
    input: Record<string, unknown>,
    context: GroveToolContext
  ): Promise<GroveToolResult> | GroveToolResult
}

/** One of grove's tools as the renderer's catalog describes a tool. */
export function toolInfoOf(tool: GroveTool): ToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    summary: tool.summary,
    policy: tool.policy,
    // Two calls to the same grove tool in one batch would race on the channel
    // or start two sessions; none of them is worth parallelising.
    parallelSafe: false,
    display: tool.display,
    inputSchema: tool.inputSchema
  }
}

/** Running totals for a session, as the harness reports them. */
export interface SessionStats {
  usage: Usage
  cost: number
  /** Tokens the conversation currently occupies, and how many it may. */
  contextUsed: number
  contextWindow: number
}

/** The session's totals as a run starts, for the harness to continue from. */
export interface StartingStats {
  usage: Usage
  cost: number
}

/** A tool call held for a decision, as ACP asks for one. */
export type ApprovalRequest = RequestPermissionRequest

export interface ApprovalDecision {
  result: ConfirmationResult
  reason?: string
  /** A replacement input, when the user edited what the tool was about to do. */
  input?: unknown
}

/**
 * An agent a runtime is running inside one of its own tool calls.
 *
 * The tool call is the identity: it is what started the agent, what its work is
 * reported under, and what ends it, so grove needs nothing else to keep one
 * agent's events apart from the next one's.
 */
export interface SubagentIdentity {
  /** The tool call that started it, and the lane its events travel in. */
  toolUseId: string
  /** What to call it — the subagent type, or the tool that started it. */
  title: string
  /** The task it was given, shown as the first thing in its transcript. */
  description?: string
}

/** Everything an adapter needs to start one session's run. */
export interface HarnessRunOptions {
  sessionId: string
  workspaceRoot: string
  provider: string | null
  model: string | null
  thinkingLevel: ThinkingLevel
  /** The tool allow-list, or null for "no allow-list". */
  activeTools: string[] | null
  /** How much the session may do without asking, as stored on it. */
  permissionMode: AgentMode
  /** Run with grove's prompt and workspace tools in place of the harness's own. */
  groveMode: boolean
  /** The harness-native conversation id from a previous grove run, if any. */
  resumeKey: string | null
  tools: GroveTool[]
  /**
   * The session's context as tagged system prompt sections — its name among
   * the agents working in the worktree, who else is there, plugin skills. The
   * harness composes its prompt around it (see `systemPrompt.ts`); one that
   * cannot take a prompt ignores it and loses only the coordination.
   */
  systemPrompt: string
  /** Report progress. The store stamps and persists whatever is emitted. */
  emit(body: ServerEventBody): void
  /**
   * Report progress from an agent this runtime is running inside a tool call.
   *
   * Runtimes that delegate — Claude's Task calls, anything a third-party harness
   * spawns — produce a second conversation that has nothing to do with the one
   * the user is reading. Reported here, grove gives it what it gives an agent of
   * its own: a session, a tab inside the family of the one that started it, its
   * own transcript and its own status. Reported through `emit`, it would splice
   * itself into the middle of whatever the main agent is saying.
   */
  emitFrom(agent: SubagentIdentity, body: ServerEventBody): void
  /**
   * Report token usage, cost and context window for the session so far. Kept off
   * the event log because it is a running total rather than something that
   * happened, and the renderer reads it from the snapshot.
   */
  stats(update: SessionStats): void
  /**
   * The totals the session already had when this run started. A runtime that
   * counts only its own process adds onto these rather than replacing them.
   */
  startingStats: StartingStats
  /**
   * Park a tool call until grove decides. grove answers from the review flow,
   * the session's permission mode, or the user, and logs the request as it
   * parks it.
   */
  confirm(request: ApprovalRequest): Promise<ApprovalDecision>
  /**
   * Store an image a tool returned and get back the blob it is shown by, so
   * the event log carries a reference rather than the bytes. Synchronous so
   * the update it belongs to is emitted in order.
   */
  storeImage(image: PromptAttachment): ImageBlock
  /**
   * Report what a command the agent runs prints, as it prints it, so the user
   * can watch it. Kept off the event log; the call's result records the output
   * once the command is done. A harness that only learns the output at the end
   * reports nothing here.
   */
  shellOutput: ShellOutputSink
}

/**
 * An image travelling with a prompt, already read off the session's blob store.
 *
 * The bytes are carried as base64 because that is the shape every model API
 * takes them in; resolving the reference here rather than in each harness keeps
 * blob storage the service's business.
 */
export interface PromptAttachment {
  mediaType: string
  /** base64, without a data: prefix. */
  data: string
}

/** One live conversation with a harness. */
export interface HarnessRun {
  /**
   * The harness-native conversation id, once it has one. Persisted so a session
   * survives a grove restart.
   */
  readonly resumeKey: string | null
  /**
   * Start a turn. Only called while the session is idle.
   *
   * `attachments` is only ever non-empty for a harness whose capabilities claim
   * `attachments`; the service reports the images as dropped rather than
   * handing them to a run that would ignore them.
   */
  prompt(text: string, attachments?: PromptAttachment[]): Promise<void>
  /**
   * Run one of the commands `offering()` listed. Harnesses that leave this out
   * get told they cannot, rather than having the ask silently dropped.
   */
  command?(name: string, args: string): Promise<void>
  /** Deliver into a turn already in flight; only when `capabilities.steering`. */
  steer?(text: string, deliverAs: DeliverAs): Promise<void>
  interrupt(): Promise<void>
  setModel?(provider: string | null, model: string): Promise<void>
  setThinkingLevel?(level: ThinkingLevel): Promise<void>
  /**
   * Switch the mode on a live run.
   *
   * Only plan mode really needs this — withholding the mutating tools is
   * something only the harness can do. grove answers the permissive modes in
   * its own approval layer, so a harness without this still honours them.
   */
  setPermissionMode?(mode: AgentMode): Promise<void>
  dispose(): Promise<void>
}

/** What a harness can offer before any session exists. */
export interface HarnessOffering {
  tools: ToolInfo[]
  commands: CommandInfo[]
  skills: SkillInfo[]
  models: ModelEntry[]
  default: { provider: string; model: string } | null
}

export interface HarnessDescriptor {
  id: string
  label: string
  description: string
  /**
   * The runtime's mark, as an Iconify icon id. The marks themselves live in the
   * renderer's `grove` collection (`lib/agents/harnessIcons`), so a harness that
   * brings a new logo adds its body there.
   */
  icon: string
  capabilities: HarnessCapabilities
  /** Is the runtime installed and authenticated? Cheap enough to call on demand. */
  probe(): Promise<{ available: boolean; detail: string | null }>
  /** Models, commands and skills this harness can offer right now. */
  offering(): Promise<HarnessOffering>
  start(options: HarnessRunOptions): Promise<HarnessRun>
}

/**
 * The harnesses currently mounted.
 *
 * Registration is revertible so a harness plugin can be unloaded: the registry
 * hands back the inverse and the kernel calls it.
 */
export class HarnessRegistry {
  private descriptors = new Map<string, HarnessDescriptor>()

  register(descriptor: HarnessDescriptor): () => void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`harness already registered: ${descriptor.id}`)
    }
    this.descriptors.set(descriptor.id, descriptor)
    return () => {
      this.descriptors.delete(descriptor.id)
    }
  }

  get(id: string): HarnessDescriptor | undefined {
    return this.descriptors.get(id)
  }

  /** The harness a session must use, or an error naming what is mounted. */
  require(id: string): HarnessDescriptor {
    const descriptor = this.descriptors.get(id)
    if (descriptor) return descriptor
    const known = [...this.descriptors.keys()].join(', ') || 'none'
    throw new Error(`unknown harness "${id}" (mounted: ${known})`)
  }

  list(): HarnessDescriptor[] {
    return [...this.descriptors.values()]
  }

  ids(): string[] {
    return [...this.descriptors.keys()]
  }

  /** The listing the renderer shows, with each harness probed for availability. */
  async describe(): Promise<HarnessInfo[]> {
    return Promise.all(this.list().map((descriptor) => describeOne(descriptor)))
  }
}

async function describeOne(descriptor: HarnessDescriptor): Promise<HarnessInfo> {
  const probe = await descriptor.probe().catch((cause: Error) => ({
    available: false,
    detail: cause.message
  }))
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    icon: descriptor.icon,
    capabilities: descriptor.capabilities,
    available: probe.available,
    detail: probe.detail
  }
}
