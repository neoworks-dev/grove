// A ramble from the desktop overlay (neoworks/overlay): what the user said
// while using their desktop, what they did meanwhile, and screenshots. The
// overlay sends a capture of the whole run over a local socket; the main
// process hands it to the focused window, whose agent pane sends it to the
// worktree's agent as a `ramble` block, shown as a card and turned into text
// for the model by `describeRamble`.
//
// The capture types are the overlay's contract (overlay/src/capture.ts),
// copied rather than shared; `version` says which one a capture follows.

export const CAPTURE_VERSION = 1

export interface RambleCapture {
  version: number
  /** Epoch ms of the first press of the talk button. */
  startedAt: number
  /** Epoch ms of sending. */
  endedAt: number
  words: CapturedWord[]
  /** What the user did, in the order it happened. */
  events: CaptureEvent[]
  /** In the order taken; `screenshot` events point into this. */
  screenshots: CapturedScreenshot[]
  /** Parts of the speech that could not be transcribed, and why. */
  speechErrors: string[]
}

export interface CapturedWord {
  text: string
  /** Ms since `startedAt`. */
  at: number
}

export interface CapturedScreenshot {
  /** Absolute path to a PNG on this machine. */
  path: string
  monitor: string
  /** Of the monitor's pixels; 0.5 is half size. */
  scale: number
}

/** A point on a monitor, in its own pixels from the top left. */
export interface Place {
  monitor: string
  x: number
  y: number
}

export interface Box extends Place {
  width: number
  height: number
}

/** What was under a gesture, named the way the overlay's tools target it. */
export type Thing =
  | { kind: 'widget'; id: string }
  | { kind: 'window'; class: string; title: string }
  | { kind: 'desktop' }

/** Every event has `at`, ms since the capture's `startedAt`. */
export type CaptureEvent =
  | { kind: 'cursor'; at: number; place: Place; on: Thing }
  | { kind: 'click'; at: number; place: Place; on: Thing }
  | { kind: 'circle'; at: number; box: Box; on: Thing }
  | { kind: 'line'; at: number; from: Place; fromThing: Thing; to: Place; toThing: Thing }
  | { kind: 'scribble'; at: number; box: Box; on: Thing }
  | { kind: 'selection'; at: number; text: string }
  | { kind: 'workspace'; at: number; workspace: string }
  | { kind: 'focus'; at: number; window: { class: string; title: string } }
  | { kind: 'drag'; at: number; widget: string; place: Place }
  | { kind: 'screenshot'; at: number; index: number }

export interface RambleImage {
  bytes: Uint8Array
  filename: string
}

/** Main to renderer: one ramble to send, its screenshots read in order. */
export interface RambleDelivery {
  id: number
  capture: RambleCapture
  images: RambleImage[]
}

/** Renderer to main: where it went, or why it didn't. */
export interface RambleReceipt {
  sessionId: string | null
  error?: string
}

// ── as text ──────────────────────────────────────────────────────────────

const HEADER =
  '[ramble: the user talked to you while using their desktop. What they did is in brackets where it happened; positions are monitor-local px. The screenshots are attached in order. The desktop-rambles skill says how to read and answer one.]'

/** The words alone, as said. */
export function saidText(capture: RambleCapture): string {
  return capture.words.map((word) => word.text).join(' ')
}

/**
 * The ramble as the model reads it: the words, with each event in brackets
 * before the first word said after it.
 */
export function describeRamble(capture: RambleCapture): string {
  const lines = [HEADER]
  for (const error of capture.speechErrors) {
    lines.push(`[part of the speech was not transcribed: ${error}]`)
  }
  lines.push(interleave(capture.words, capture.events))
  return lines.join('\n')
}

function interleave(words: CapturedWord[], events: CaptureEvent[]): string {
  const parts: string[] = []
  let next = 0
  for (const word of words) {
    while (next < events.length && events[next].at <= word.at) {
      parts.push(`[${describeEvent(events[next])}]`)
      next++
    }
    parts.push(word.text)
  }
  for (; next < events.length; next++) {
    parts.push(`[${describeEvent(events[next])}]`)
  }
  return parts.join(' ')
}

export function describeEvent(event: CaptureEvent): string {
  switch (event.kind) {
    case 'cursor':
      return `cursor on ${describeThing(event.on, event.place)}`
    case 'click':
      return `clicked ${describeThing(event.on, event.place)}`
    case 'circle':
      return `circled ${describeThing(event.on, event.box)} (${describeBox(event.box)})`
    case 'line':
      return `drew a line from ${describeThing(event.fromThing, event.from)} to ${describeThing(event.toThing, event.to)}`
    case 'scribble':
      return `scribbled on ${describeThing(event.on, event.box)} (${describeBox(event.box)})`
    case 'selection':
      return `selected "${event.text}"`
    case 'workspace':
      return `switched to workspace ${event.workspace}`
    case 'focus':
      return `focused window class:${event.window.class} "${event.window.title}"`
    case 'drag':
      return `dragged widget:${event.widget} to ${describePlace(event.place)}`
    case 'screenshot':
      return `screenshot ${event.index + 1}`
    default:
      // A kind from a newer overlay.
      return (event as { kind: string }).kind
  }
}

/** `widget:plan at 10,20 on DP-2`, `window class:kitty "~" at …`, `the desktop at …`. */
export function describeThing(thing: Thing, place: Place): string {
  const at = describePlace(place)
  if (thing.kind === 'widget') return `widget:${thing.id} at ${at}`
  if (thing.kind === 'window') return `window class:${thing.class} "${thing.title}" at ${at}`
  return `the desktop at ${at}`
}

function describePlace(place: Place): string {
  return `${Math.round(place.x)},${Math.round(place.y)} on ${place.monitor}`
}

function describeBox(box: Box): string {
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
}
