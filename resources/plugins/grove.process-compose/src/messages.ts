// What the worker and the pane page say to each other. Imported by both, so
// the two sides can't drift apart; types only, nothing here runs.

import type { ProcessStatus } from './runner'

export interface ProcessView {
  name: string
  command: string
  workingDir: string
  dependsOn: { name: string; condition: string }[]
  status: ProcessStatus
  exitCode: number | null
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

export type ToWorker =
  | { type: 'start'; name?: string }
  | { type: 'stop'; name?: string }
  | { type: 'restart'; name?: string }
  | { type: 'select-file'; file: string }
  | { type: 'open-file' }
  // Keys typed into a process's terminal.
  | { type: 'input'; name: string; data: string }
  | { type: 'resize'; name: string; cols: number; rows: number }
