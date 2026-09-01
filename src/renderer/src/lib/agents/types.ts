// The agent protocol, as the renderer sees it.
//
// The vocabulary itself is shared with the main process, which is where the
// harness adapters translate their SDKs into it. Re-exported here so the agent
// pane and its components have one local module to import from.

export type {
  BlobDescriptor,
  ClientEventBody,
  CommandInfo,
  ConfirmationResult,
  ContentBlock,
  ContextUsage,
  CreateSessionOptions,
  DeliverAs,
  EventBody,
  EventEnvelope,
  FileMatch,
  HarnessCapabilities,
  HarnessCatalog,
  HarnessInfo,
  IdleReason,
  ImageBlock,
  ModelInfo,
  ModelPricing,
  ProviderModels,
  QueuedMessage,
  ServerEventBody,
  SessionEvent,
  SessionMeta,
  SessionSnapshot,
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
