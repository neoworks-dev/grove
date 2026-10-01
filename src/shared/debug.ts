// Types the debugger sends across IPC. The Debug Adapter Protocol client lives
// in the main process (src/main/debug); the renderer and nvim only ever see
// these shapes, and an agent tool reading debug state would see the same ones.

/** Who set a breakpoint: the person at the editor, or an agent driving the debugger. */
export type BreakpointOrigin = 'user' | 'agent'

/** A line breakpoint, as Grove keeps it across sessions and restarts. */
export interface DebugBreakpoint {
  id: string
  /** Absolute path of the file. */
  path: string
  /** 1-based line. */
  line: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
  origin: BreakpointOrigin
  /** Whether a running adapter accepted it. False with no session running. */
  verified: boolean
  /** Why the adapter did not accept it, when it said. */
  message?: string
}

/** Fields a caller may set when adding or editing a breakpoint. */
export interface DebugBreakpointOptions {
  condition?: string
  hitCondition?: string
  logMessage?: string
  origin?: BreakpointOrigin
}

/** One exception filter an adapter offers ("Uncaught Exceptions", "Raised Exceptions"). */
export interface DebugExceptionFilter {
  filter: string
  label: string
  description?: string
  enabled: boolean
}

export type DebugSessionState = 'initializing' | 'running' | 'stopped' | 'terminated'

/** A frame of a stopped thread's call stack. Lines are 1-based. */
export interface DebugStackFrame {
  id: number
  name: string
  /** Absolute path of the frame's source, when it has one on disk. */
  path?: string
  /** Display name of the source (file name, or the adapter's name for it). */
  sourceName?: string
  line: number
  column: number
  /** 'subtle' frames are library or internal code the UI may fold away. */
  presentationHint?: 'normal' | 'label' | 'subtle'
}

export interface DebugThread {
  id: number
  name: string
  stopped: boolean
  /** The top of its call stack, loaded when the thread stops. */
  frames: DebugStackFrame[]
  /** Whether the adapter has more frames than `frames` holds. */
  moreFrames: boolean
}

/** Where execution stopped, for the editor to reveal and mark. */
export interface DebugLocation {
  path: string
  line: number
}

export interface DebugSessionSummary {
  id: string
  /** The configuration's name, shown in the UI. */
  name: string
  /** Set on a child session an adapter started (js-debug's per-process sessions). */
  parentId: string | null
  /** The adapter's launch.json `type`. */
  type: string
  worktreePath: string
  state: DebugSessionState
  threads: DebugThread[]
  /** The thread that stopped last, and why. */
  stoppedThreadId: number | null
  stopReason: string | null
  /** Text the adapter attached to the stop, such as an exception's message. */
  stopDescription: string | null
  /** The adapter's exception filters, with the ones turned on marked. */
  exceptionFilters: DebugExceptionFilter[]
  supportsRestart: boolean
  supportsTerminate: boolean
  /** Whether the adapter evaluates in the debug console with completions. */
  supportsCompletions: boolean
}

/** Everything the UI draws from, pushed on every change as `event:debug-state`. */
export interface DebugSnapshot {
  breakpoints: DebugBreakpoint[]
  sessions: DebugSessionSummary[]
  /** The session the UI and the step commands act on. */
  focusedSessionId: string | null
  /** The frame the variables view and evaluate read in. */
  focusedFrameId: number | null
  /** Where the focused session's selected frame is, for the editor's marker. */
  focusedLocation: DebugLocation | null
  /** Bumped on every stop, so the editor reveals each stop exactly once. */
  stopSequence: number
  /** Watch expressions, kept per repository. */
  watches: string[]
}

export type DebugOutputCategory =
  'console' | 'stdout' | 'stderr' | 'important' | 'telemetry' | 'input' | 'result' | 'error'

/** One entry in the Debug Console. */
export interface DebugOutputLine {
  sequence: number
  sessionId: string | null
  category: DebugOutputCategory
  text: string
  /** Set on an evaluation result whose value can be expanded. */
  variablesReference?: number
}

export interface DebugScope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  /** Non-zero when the value has children to expand. */
  variablesReference: number
  evaluateName?: string
}

export interface DebugEvaluation {
  result: string
  type?: string
  variablesReference: number
}

/** Where a launch configuration came from. */
export type DebugConfigurationSource = 'launch.json' | 'adapter'

/** A launch configuration the user can start, with its adapter's readiness. */
export interface DebugConfigurationEntry {
  /** Stable within one listing: source plus name. */
  key: string
  name: string
  type: string
  request: 'launch' | 'attach'
  source: DebugConfigurationSource
  /** The configuration as written, before variables are substituted. */
  configuration: Record<string, unknown>
  /** The adapter that serves `type`, or null when none is known. */
  adapterId: string | null
  /** Whether that adapter can start right now. */
  adapterReady: boolean
  /** The Mason package that would make it ready, when it is not. */
  installPackage: string | null
}

/** A debug adapter Grove knows how to start, and whether it can. */
export interface DebugAdapterInfo {
  id: string
  label: string
  types: string[]
  languages: string[]
  /** Where its executable was found, or null when it is missing. */
  executable: string | null
  masonPackage: string | null
  installing: boolean
}

/** A DAP-capable package Mason offers, for adapters Grove has no descriptor for. */
export interface MasonDebugPackage {
  name: string
  languages: string[]
  installed: boolean
}
