// What a command acts on, as typed on the command line.
//
//   Problems          the text on screen that reads "Problems", found by reading
//                     a screenshot (see ocr.ts)
//   text=Problems     the same, spelled out when the text looks like a point
//   at=820,460        a point in the window, for what shows no text: a divider,
//                     an icon, a spot in the editor
//
// A text target that matches several places takes `--nth <n>` (1 is the first,
// top to bottom); the error lists where each match is.

export type Target = { kind: 'point'; x: number; y: number } | { kind: 'text'; text: string }

/** Parses one target. */
export function parseTarget(input: string): Target {
  const value = input.trim()
  if (value.length === 0) {
    throw new Error('a target is empty')
  }
  if (value.startsWith('at=')) {
    return parsePoint(value.slice(3))
  }
  if (value.startsWith('text=')) {
    const text = value.slice(5).trim()
    if (text.length === 0) {
      throw new Error('text= target is empty')
    }
    return { kind: 'text', text }
  }
  return { kind: 'text', text: value }
}

/** `820,460` as a point, or an error that says what a point looks like. */
function parsePoint(input: string): Target {
  const parts = input.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`a point is two numbers, at=x,y — got at=${input}`)
  }
  return { kind: 'point', x: Math.round(parts[0]), y: Math.round(parts[1]) }
}

/** A rectangle of the window, for a screenshot of part of it. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** `820,460,300,200` — where to crop a screenshot, as x,y,width,height. */
export function parseRegion(input: string): Region {
  const parts = input.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`a crop is four numbers, x,y,width,height — got ${input}`)
  }
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) {
    throw new Error(`a crop needs a positive width and height — got ${input}`)
  }
  return { x, y, width, height }
}

/** How a target reads back in an error or a log line. */
export function describeTarget(target: Target): string {
  if (target.kind === 'text') {
    return `"${target.text}"`
  }
  return `point ${target.x},${target.y}`
}
