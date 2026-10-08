// A ramble as the transcript card shows it: runs of what was said, with what
// the user did as small chips where it happened. The model gets the same
// order as text (`describeRamble`); this is the version for reading at a
// glance, so each chip names its thing briefly and keeps the rest for a tooltip.

import {
  describeEvent,
  type CaptureEvent,
  type RambleCapture,
  type Thing
} from '../../../../shared/ramble'

export type RambleSegment =
  | { kind: 'words'; text: string }
  | { kind: 'event'; event: CaptureEvent; label: string; detail: string }

const MAX_SELECTION_CHARS = 60

/** Said words and events, interleaved by time; consecutive words make one run. */
export function rambleSegments(capture: RambleCapture): RambleSegment[] {
  const segments: RambleSegment[] = []
  let run: string[] = []
  const flush = (): void => {
    if (run.length === 0) return
    segments.push({ kind: 'words', text: run.join(' ') })
    run = []
  }
  let next = 0
  const events = capture.events
  for (const word of capture.words) {
    while (next < events.length && events[next].at <= word.at) {
      flush()
      segments.push(eventSegment(events[next]))
      next++
    }
    run.push(word.text)
  }
  flush()
  for (; next < events.length; next++) segments.push(eventSegment(events[next]))
  return segments
}

function eventSegment(event: CaptureEvent): RambleSegment {
  return { kind: 'event', event, label: eventLabel(event), detail: describeEvent(event) }
}

/** A few words for a chip: `clicked kitty`, `workspace 3`. */
export function eventLabel(event: CaptureEvent): string {
  switch (event.kind) {
    case 'cursor':
      return thingLabel(event.on)
    case 'click':
      return `clicked ${thingLabel(event.on)}`
    case 'circle':
      return `circled ${thingLabel(event.on)}`
    case 'line':
      return `${thingLabel(event.fromThing)} → ${thingLabel(event.toThing)}`
    case 'scribble':
      return `scribbled on ${thingLabel(event.on)}`
    case 'selection':
      return `“${clip(event.text, MAX_SELECTION_CHARS)}”`
    case 'workspace':
      return `workspace ${event.workspace}`
    case 'focus':
      return event.window.class
    case 'drag':
      return `moved ${event.widget}`
    case 'screenshot':
      return `screenshot ${event.index + 1}`
    default:
      return (event as { kind: string }).kind
  }
}

function thingLabel(thing: Thing): string {
  if (thing.kind === 'widget') return thing.id
  if (thing.kind === 'window') return thing.class
  return 'desktop'
}

/** `23s`, `1m 5s`. */
export function rambleDuration(capture: RambleCapture): string {
  const seconds = Math.max(0, Math.round((capture.endedAt - capture.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}
