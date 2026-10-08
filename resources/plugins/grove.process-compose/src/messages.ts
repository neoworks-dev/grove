// What the worker and the pane page say to each other. Imported by both, so
// the two sides can't drift apart; types only, nothing here runs.

import type { ProcessStatus } from './runner'

export interface ProcessView {
  name: string
  command: string
  workingDir: string
  dependsOn: { name: string; condition: string }[]
  // The file's global environment merged with the process's own.
  environment: Record<string, string>
  // The file disables it: Start all leaves it out, though it can be started alone.
  disabled: boolean
  status: ProcessStatus
  exitCode: number | null
  // When the current or last run started (epoch ms); null if it never ran.
  startedAt: number | null
  // Runs since the project was last started as a whole, beyond the first.
  restarts: number
  // While skipped: the dependency that can no longer be met.
  blockedBy: string | null
}

// How the pane is laid out, kept by the worker so it survives a restart.
export interface PanePrefs {
  // The process list's width in px; null for the default.
  listWidth: number | null
  // Whether long output lines wrap; otherwise the output scrolls sideways.
  wrap: boolean
}

export interface ProjectView {
  // The worktree the pane is showing, as its branch; null with none open.
  branch: string | null
  // Every process-compose file in the worktree, and the one in use.
  files: string[]
  file: string | null
  // Why the file couldn't be used, when it couldn't.
  error: string | null
  processes: ProcessView[]
}

export type ToPage =
  | { type: 'state'; project: ProjectView }
  // A process's whole output so far (sent on open, worktree switch, restart).
  | { type: 'output-reset'; name: string; data: string }
  // Output appended since the last message.
  | { type: 'output'; name: string; data: string }
  | { type: 'prefs'; prefs: PanePrefs }

export type ToWorker =
  | { type: 'start'; name?: string }
  | { type: 'stop'; name?: string }
  | { type: 'restart'; name?: string }
  | { type: 'select-file'; file: string }
  | { type: 'open-file' }
  // Keys typed into a process's terminal.
  | { type: 'input'; name: string; data: string }
  | { type: 'resize'; name: string; cols: number; rows: number }
  // Drops a process's output so far, for the page and pages opened later.
  | { type: 'clear-output'; name: string }
  // Copies a process's output so far, as plain text, to the clipboard.
  | { type: 'copy-output'; name: string }
  | { type: 'set-prefs'; prefs: Partial<PanePrefs> }
