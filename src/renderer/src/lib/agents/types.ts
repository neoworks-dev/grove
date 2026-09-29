// The agent protocol, as the renderer sees it.
//
// The vocabulary itself is shared with the main process; what a harness says is
// ACP, as switchboard reported it. Re-exported here so the agent pane and its
// components have one local module to import from.

export type {
  AgentMode,
  BlobDescriptor,
  CodeLocation,
  LineAnnotation,
  LocationState,
  ResolvedLocation,
  ClientEventBody,
  CommandInfo,
  ConfirmationResult,
  ContentBlock,
  ContextUsage,
  CreateSessionOptions,
  CustomEndpoint,
  DeliverAs,
  EventBody,
  EventEnvelope,
  FileBlock,
  FileMatch,
  ShellCompletion,
  HarnessCapabilities,
  HarnessCatalog,
  HarnessInfo,
  IdleReason,
  ImageBlock,
  ModelEntry,
  ModelPricing,
  ModelRoute,
  ProviderCredential,
  QueuedMessage,
  ServerEventBody,
  SessionEvent,
  SessionMeta,
  SessionNote,
  SessionSnapshot,
  ShellOutputSnapshot,
  ShellOutputUpdate,
  ShowTarget,
  SessionStatus,
  SessionUpdate,
  SkillInfo,
  TextBlock,
  ThinkingLevel,
  ToolDisplay,
  ToolInfo,
  ToolInputView,
  ToolPermission,
  ToolPolicy,
  ToolResultView,
  UiNode,
  UiSlot,
  UiTone,
  Usage,
  UserContentBlock
} from '../../../../shared/agents'

export { commandLine } from '../../../../shared/agents'

export type {
  ContentBlock as AcpContentBlock,
  RequestPermissionRequest,
  SessionUpdate as AcpSessionUpdate,
  ToolCallUpdate
} from '@neoworks/harness'

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the plan a harness keeps for itself, as ACP's `plan` reports it. */
export interface AgentTask {
  id: string
  text: string
  status: AgentTaskStatus
}
