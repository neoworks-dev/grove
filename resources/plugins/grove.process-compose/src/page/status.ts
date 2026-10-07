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
  if (process.status === 'completed') {
    if (process.exitCode === null) return 'done'
    return `exited ${process.exitCode}`
  }
  if (process.status === 'failed') {
    if (process.exitCode === null) return 'failed'
    return `exit ${process.exitCode}`
  }
  if (process.status === 'waiting') return 'waiting on deps'
  return process.status
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

const DOTS: Record<ProcessStatus, string> = {
  idle: 'bg-faint',
  disabled: 'border border-dashed border-faint',
  waiting: 'bg-amber',
  running: 'bg-green animate-[process-pulse_1.8s_ease-out_infinite] shadow-[0_0_0_0_var(--ctx-green)]',
  stopping: 'bg-amber',
  completed: 'bg-green/50',
  failed: 'bg-red',
  stopped: 'bg-faint',
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
