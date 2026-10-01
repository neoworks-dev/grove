// Marking up an image before it goes to an agent: the marks, their history, and
// how they are drawn.
//
// Marks are kept as shapes in the image's own pixels, not as paint, so undo is
// dropping the last one and reopening a marked-up image picks up where it was
// left. Only sending flattens them into a picture.

export type MarkTool = 'arrow' | 'box' | 'pen' | 'text' | 'blur'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Mark =
  | { kind: 'arrow'; from: Point; to: Point; color: string; width: number }
  | { kind: 'box'; rect: Rect; color: string; width: number }
  | { kind: 'pen'; points: Point[]; color: string; width: number }
  | { kind: 'text'; at: Point; text: string; color: string; size: number }
  | { kind: 'blur'; rect: Rect }

/** The colours a mark can be drawn in; the first is the default. */
export const MARK_COLORS = ['#f04848', '#f5a524', '#3b9eff', '#3ecf6e', '#ffffff'] as const

// Below this, in image pixels, a drag was a click that slipped.
const MIN_DRAG = 4

/** The rectangle two corners span, whichever way the drag went. */
export function rectBetween(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

/** Whether a finished mark has enough to it to keep. */
export function isMeaningful(mark: Mark): boolean {
  if (mark.kind === 'arrow') return distance(mark.from, mark.to) >= MIN_DRAG
  if (mark.kind === 'box' || mark.kind === 'blur') {
    return mark.rect.width >= MIN_DRAG && mark.rect.height >= MIN_DRAG
  }
  if (mark.kind === 'pen') return mark.points.length > 1
  return mark.text.trim().length > 0
}

/** How thick a line reads well on an image this size. */
export function strokeWidthFor(imageWidth: number, imageHeight: number): number {
  const longest = Math.max(imageWidth, imageHeight)
  return Math.max(2, Math.round(longest / 320))
}

/** How large a label reads well on an image this size. */
export function textSizeFor(imageWidth: number, imageHeight: number): number {
  return strokeWidthFor(imageWidth, imageHeight) * 7
}

/** The two ends of an arrow's head, swept back from its tip. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const length = Math.max(10, width * 5)
  const spread = Math.PI / 7
  return [
    {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread)
    },
    {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread)
    }
  ]
}

/** Straight-line distance between two points. */
function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// ── History ───────────────────────────────────────────────────────

/** The marks on the image, and every earlier and undone state of them. */
export interface MarkHistory {
  past: Mark[][]
  present: Mark[]
  future: Mark[][]
}

/** A history starting from the given marks, with nothing to undo. */
export function startHistory(marks: Mark[]): MarkHistory {
  return { past: [], present: marks, future: [] }
}

/** The history with `marks` as its new present; whatever was undone is gone. */
export function commit(history: MarkHistory, marks: Mark[]): MarkHistory {
  return { past: [...history.past, history.present], present: marks, future: [] }
}

/** The history with one more mark. */
export function addMark(history: MarkHistory, mark: Mark): MarkHistory {
  return commit(history, [...history.present, mark])
}

/** Back one step, or the same history when there is nothing to undo. */
export function undo(history: MarkHistory): MarkHistory {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future]
  }
}

/** Forward one undone step, or the same history when nothing was undone. */
export function redo(history: MarkHistory): MarkHistory {
  if (history.future.length === 0) return history
  const [next, ...rest] = history.future
  return { past: [...history.past, history.present], present: next, future: rest }
}

// ── Drawing ───────────────────────────────────────────────────────

/**
 * Draws the image with its marks onto a canvas the image's size. `blurred` is
 * the image already blurred whole; a blur mark shows its part of it, so what
 * is under the mark is never in the picture at all.
 */
export function drawMarkup(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  blurred: CanvasImageSource,
  marks: readonly Mark[]
): void {
  const { width, height } = context.canvas
  context.clearRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  for (const mark of marks) {
    drawMark(context, mark, blurred)
  }
}

/** Draws one mark. */
export function drawMark(
  context: CanvasRenderingContext2D,
  mark: Mark,
  blurred: CanvasImageSource
): void {
  context.save()
  if (mark.kind === 'blur') drawBlur(context, mark.rect, blurred)
  if (mark.kind === 'box') drawBox(context, mark.rect, mark.color, mark.width)
  if (mark.kind === 'arrow') drawArrow(context, mark.from, mark.to, mark.color, mark.width)
  if (mark.kind === 'pen') drawPen(context, mark.points, mark.color, mark.width)
  if (mark.kind === 'text') drawText(context, mark.at, mark.text, mark.color, mark.size)
  context.restore()
}

/** Shows the blurred copy of the image inside the mark's rectangle. */
function drawBlur(context: CanvasRenderingContext2D, rect: Rect, blurred: CanvasImageSource): void {
  context.beginPath()
  context.rect(rect.x, rect.y, rect.width, rect.height)
  context.clip()
  context.drawImage(blurred, 0, 0, context.canvas.width, context.canvas.height)
}

/** A rectangle outline. */
function drawBox(context: CanvasRenderingContext2D, rect: Rect, color: string, width: number): void {
  context.strokeStyle = color
  context.lineWidth = width
  context.lineJoin = 'round'
  context.strokeRect(rect.x, rect.y, rect.width, rect.height)
}

/** A line with a filled head at its `to` end. */
function drawArrow(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  color: string,
  width: number
): void {
  const [left, right] = arrowHead(from, to, width)
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
  context.beginPath()
  context.moveTo(to.x, to.y)
  context.lineTo(left.x, left.y)
  context.lineTo(right.x, right.y)
  context.closePath()
  context.fill()
}

/** A freehand stroke through its points. */
function drawPen(context: CanvasRenderingContext2D, points: readonly Point[], color: string, width: number): void {
  if (points.length === 0) return
  context.strokeStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y)
  }
  context.stroke()
}

/** A label: the text over a dark halo, so it reads on any background. */
function drawText(
  context: CanvasRenderingContext2D,
  at: Point,
  text: string,
  color: string,
  size: number
): void {
  context.font = `600 ${size}px system-ui, sans-serif`
  context.textBaseline = 'top'
  context.lineJoin = 'round'
  context.lineWidth = Math.max(2, size / 5)
  context.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  context.strokeText(text, at.x, at.y)
  context.fillStyle = color
  context.fillText(text, at.x, at.y)
}
