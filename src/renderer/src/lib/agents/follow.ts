// Follow mode: every file the agent reads or writes opens in the editor as the
// call comes in. The one subtlety is timing — a harness that streams a call's
// arguments reports the call before it knows the file, so a call is only done
// with once its file is known, or once it has settled without one.

import type { ToolItem, TranscriptItem } from './transcript'

export interface FollowStep {
  /** Files to open now, in the order their calls came. */
  open: string[]
  /** Every call follow mode is done with, the ones before included. */
  followed: Set<string>
}

/**
 * The files the calls on screen ask follow mode to open now. A call whose file
 * is known opens it once; one that settled without a file is done with; one
 * still arriving without a file yet is looked at again next time.
 */
export function followStep(
  items: TranscriptItem[],
  followed: Set<string>,
  fileOf: (call: ToolItem) => string | null
): FollowStep {
  const open: string[] = []
  const done: string[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || followed.has(item.toolUseId)) continue
    const path = fileOf(item)
    if (path) {
      open.push(path)
      done.push(item.toolUseId)
      continue
    }
    if (isSettled(item)) done.push(item.toolUseId)
  }
  if (done.length === 0) return { open, followed }
  return { open, followed: new Set([...followed, ...done]) }
}

/** A call that is over: its arguments will not change any more. */
function isSettled(call: ToolItem): boolean {
  return call.status === 'ok' || call.status === 'error' || call.status === 'denied'
}
