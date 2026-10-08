// How a process's state reads on screen: its label, its colour, its dot.

import type { StatusTone } from '@neoworks-dev/ui'
import type { ProcessView } from '../messages'
import type { ProcessStatus } from '../runner'

/** Whether the process is running or about to: what Stop applies to. */
export function isLive(status: ProcessStatus): boolean {
  return status === 'running' || status === 'waiting' || status === 'stopping'
}

/** The short word for a process's state. */
export function statusLabel(process: ProcessView): string {
  // Completed means it exited 0, which the check mark already says.
  if (process.status === 'completed') return 'done'
  if (process.status === 'failed') {
    if (process.exitCode === null) return 'failed'
    return `exit ${process.exitCode}`
  }
  if (process.status === 'waiting') return 'waiting on deps'
  return process.status
}

// What happened to a dependency, as it reads after its name.
const BLOCKER_OUTCOMES: Partial<Record<ProcessStatus, string>> = {
  failed: 'failed',
  skipped: 'was skipped',
  stopped: 'was stopped',
  completed: 'finished'
}

/** Why a skipped process never started: "caddy failed"; '' for any other process. */
export function skipReason(process: ProcessView, processes: ProcessView[]): string {
  if (process.status !== 'skipped' || !process.blockedBy) return ''
  const blocker = processes.find((candidate) => candidate.name === process.blockedBy)
  const outcome = blocker ? BLOCKER_OUTCOMES[blocker.status] : undefined
  if (!outcome) return `${process.blockedBy} can't be met`
  return `${process.blockedBy} ${outcome}`
}

/**
 * The label a list row shows: nothing for a process that hasn't run, whose dot
 * already says so; how long it has been up while running; else the state's word.
 */
export function rowStatusLabel(process: ProcessView, now: number): string {
  if (!hasRun(process.status)) return ''
  if (process.status === 'running' && process.startedAt !== null) {
    return `up ${formatDuration(now - process.startedAt)}`
  }
  return statusLabel(process)
}

/** How often a process restarted since the project started, for a row: "↻2", or nothing. */
export function restartLabel(process: ProcessView): string {
  if (process.restarts === 0) return ''
  return `↻${process.restarts}`
}

/** A duration as its two largest units: "12s", "3m 4s", "2h 5m", "1d 3h". */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Whether the process has started at least once, so it has output to show. */
export function hasRun(status: ProcessStatus): boolean {
  return status !== 'idle' && status !== 'disabled'
}

const TONES: Record<ProcessStatus, StatusTone> = {
  idle: 'neutral',
  disabled: 'neutral',
  waiting: 'amber',
  running: 'green',
  stopping: 'amber',
  completed: 'neutral',
  failed: 'red',
  stopped: 'neutral',
  skipped: 'neutral'
}

/** The badge colour for a process's state. */
export function statusTone(status: ProcessStatus): StatusTone {
  return TONES[status]
}

// Never run is a faint filled dot and stopped by hand a hollow ring, so the
// two read apart. Completed and failed draw a check and a cross (StatusDot).
const DOTS: Record<ProcessStatus, string> = {
  idle: 'bg-faint',
  disabled: 'border border-dashed border-faint',
  waiting: 'bg-amber',
  running: 'bg-green animate-[process-pulse_1.8s_ease-out_infinite] shadow-[0_0_0_0_var(--ctx-green)]',
  stopping: 'bg-amber',
  completed: '',
  failed: '',
  stopped: 'border-[1.5px] border-dim',
  skipped: 'border border-dashed border-faint'
}

/** The classes for a process's status dot. */
export function dotClasses(status: ProcessStatus): string {
  return DOTS[status]
}

/** How a dependency's condition reads after "after <name>". */
export function conditionSuffix(condition: string): string {
  if (condition === 'process_completed') return ' finishes'
  if (condition === 'process_completed_successfully') return ' succeeds'
  if (condition === 'process_healthy') return ' is healthy'
  return ''
}

// Dependencies named on a row before the rest collapse into a count.
const DEPENDENCIES_NAMED = 2

/** A process's dependencies on one line: "after redis, nats +3". */
export function dependencySummary(dependsOn: ProcessView['dependsOn']): string {
  const names = dependsOn.slice(0, DEPENDENCIES_NAMED).map((dependency) => dependency.name)
  const rest = dependsOn.length - names.length
  if (rest > 0) return `after ${names.join(', ')} +${rest}`
  return `after ${names.join(', ')}`
}

/** Every dependency with its condition, one per line, for a tooltip. */
export function dependencyDetails(dependsOn: ProcessView['dependsOn']): string {
  return dependsOn
    .map((dependency) => `after ${dependency.name}${conditionSuffix(dependency.condition)}`)
    .join('\n')
}
