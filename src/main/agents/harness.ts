// The harness contract and the registry plugins publish into.
//
// A harness is one coding agent runtime — the Claude Agent SDK, the Codex SDK,
// pi — wrapped so grove can drive it through a single vocabulary. Everything
// grove needs from a runtime is here: whether it can run at all, what it can
// offer (models, commands, skills), and how to start and steer one session.
//
// Adapters never touch grove's session store. They emit normalized event bodies
// and the store stamps sequence numbers, persists them and fans them out.

import type {
  CommandInfo,
  ConfirmationResult,
  DeliverAs,
  HarnessCapabilities,
  HarnessInfo,
  ProviderModels,
  ServerEventBody,
  SkillInfo,
  ThinkingLevel,
  ToolDisplay,
  ToolInfo,
  ToolPolicy,
  Usage
} from '../../shared/agents'

/** What a grove-owned tool needs from the session that called it. */
export interface GroveToolContext {
  sessionId: string
  workspaceRoot: string
  /** Publish a declarative view under a surface id the renderer watches. */
  surface(surfaceId: string, slot: 'transcript' | 'panel', view: unknown): void
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
  summary: string
  description: string
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>
  /** `ask` parks the call until grove answers it; `allow` runs straight away. */
  policy: ToolPolicy
  display?: ToolDisplay
  execute(
    input: Record<string, unknown>,
    context: GroveToolContext
  ): Promise<GroveToolResult> | GroveToolResult
}

/** Running totals for a session, as the harness reports them. */
export interface SessionStats {
  usage: Usage
  cost: number
  contextWindow: number
}

export interface ApprovalRequest {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface ApprovalDecision {
  result: ConfirmationResult
  reason?: string
  /** A replacement input, when the user edited what the tool was about to do. */
  input?: unknown
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
  /** The harness-native conversation id from a previous grove run, if any. */
  resumeKey: string | null
  tools: GroveTool[]
  /** Report progress. The store stamps and persists whatever is emitted. */
  emit(body: ServerEventBody): void
  /**
   * Report token usage, cost and context window for the session so far. Kept off
   * the event log because it is a running total rather than something that
   * happened, and the renderer reads it from the snapshot.
   */
  stats(update: SessionStats): void
  /**
   * Park a tool call until grove decides. Adapters only call this when their
   * capabilities declare `approvals`; grove answers from the review flow, the
   * session's permission mode, or the user.
   */
  confirm(request: ApprovalRequest): Promise<ApprovalDecision>
}

/** One live conversation with a harness. */
export interface HarnessRun {
  /**
   * The harness-native conversation id, once it has one. Persisted so a session
   * survives a grove restart.
   */
  readonly resumeKey: string | null
  /** Start a turn. Only called while the session is idle. */
  prompt(text: string): Promise<void>
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
  dispose(): Promise<void>
}

/** What a harness can offer before any session exists. */
export interface HarnessOffering {
  tools: ToolInfo[]
  commands: CommandInfo[]
  skills: SkillInfo[]
  providers: ProviderModels[]
  default: { provider: string; model: string } | null
}

/**
 * What grove should make of a tool call.
 *
 * Every harness names and shapes its tools differently — `Write` with a
 * `file_path` here, `write` with a `path` there — and the review flow needs to
 * know which calls change files and what they would leave on disk. Each adapter
 * answers for its own tools, so nothing outside it has to learn their names.
 */
export type ToolIntent =
  | { kind: 'review'; summary: string }
  | {
      kind: 'write'
      /** Absolute, or relative to the workspace root. */
      path: string
      /** What the file would contain afterwards, or null when it cannot be known. */
      apply(original: string): string | null
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
  /** Classify a tool call for the review flow; null for calls it does not care about. */
  intentOf(name: string, input: Record<string, unknown>): ToolIntent | null
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
