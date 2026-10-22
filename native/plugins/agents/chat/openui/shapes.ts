// The generic Shape: a rect, line, path or arc in a box of 0 to 1 on both sides (left top corner
// 0,0) that the parent sizes. The window draws each as an SVG of the box's pixels that the `Icon`
// tints with the shape's tone. Plain functions, tested without a window.
import type { UiNode } from "@suite/protocol/types";
import { linePath, onCircle, svgDocument, type Point } from "./charts";
import { bool, num, numbers, str } from "./props";

/** Width over height of a box whose shape gives none. */
const ASPECT = 2;

/** The least and the most a box is tall, in pixels, whatever its aspect. */
const MIN_HEIGHT = 4;
const MAX_HEIGHT = 480;

const STROKE = 2;

const r = (n: number): string => String(Math.round(n * 100) / 100);

/** The aspect of a shape's box: its own `aspect` when it is a positive number. */
export function aspectOf(node: UiNode): number {
  const aspect = num(node, "aspect");
  return aspect !== undefined && aspect > 0 ? aspect : ASPECT;
}

/** How tall the box of shapes is across `width` pixels: that over the first shape's aspect. */
export function canvasHeight(width: number, shapes: readonly UiNode[]): number {
  const first = shapes[0];
  const height = width / (first === undefined ? ASPECT : aspectOf(first));
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
}

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** The points of a shape as pixels of a `width` by `height` box, pairs of numbers read as x, y. */
function pixels(points: readonly number[], width: number, height: number): Point[] {
  const out: Point[] = [];
  for (let at = 0; at + 1 < points.length; at += 2) {
    out.push({ x: unit(points[at] ?? 0) * width, y: unit(points[at + 1] ?? 0) * height });
  }
  return out;
}

/** The path of an arc of `sweep` degrees from `from`; a wedge goes on to the center and closes. */
function arcPath(c: Point, radius: number, from: number, sweep: number, wedge: boolean): string {
  // One arc cannot be a whole circle.
  const span = Math.min(359.99, sweep);
  const a = onCircle(c.x, c.y, radius, from);
  const b = onCircle(c.x, c.y, radius, from + span);
  const arc = `M${r(a.x)} ${r(a.y)} A${r(radius)} ${r(radius)} 0 ${span > 180 ? 1 : 0} 1 ${r(b.x)} ${r(b.y)}`;
  return wedge ? `${arc} L${r(c.x)} ${r(c.y)} Z` : arc;
}

/** Turns clockwise from `from` to `to` as degrees: the way round that passes the top counts. */
function sweepOf(from: number, to: number): number {
  const span = to - from;
  if (Math.abs(span) >= 1) return 360;
  return (((span % 1) + 1) % 1) * 360;
}

/** The shape as an SVG document of `width` by `height` pixels, black for the `Icon` to tint. */
export function shapeSvg(node: UiNode, width: number, height: number): string {
  const kind = str(node, "kind");
  const points = numbers(node, "points");
  const fill = bool(node, "fill") === true;
  const ink = fill
    ? `fill="#000" stroke="#000" stroke-width="1"`
    : `fill="none" stroke="#000" stroke-width="${STROKE}"`;
  const join = `stroke-linecap="round" stroke-linejoin="round"`;
  let body = "";
  if (kind === "rect" && points.length >= 4) {
    const [x, y, w, h] = points as [number, number, number, number];
    // A stroke is drawn half in and half out: an outline sits inside the box so none is cut off.
    const inset = fill ? 0 : STROKE / 2;
    const left = unit(x) * width;
    const top = unit(y) * height;
    const wide = Math.max(0, unit(x + w) * width - left);
    const tall = Math.max(0, unit(y + h) * height - top);
    body = `<rect x="${r(left + inset)}" y="${r(top + inset)}" width="${r(Math.max(1, wide - inset * 2))}" height="${r(Math.max(1, tall - inset * 2))}" ${ink}/>`;
  } else if (kind === "line" && points.length >= 2) {
    const pts = pixels(points, width, height);
    // A single point is a dot.
    const d =
      pts.length === 1
        ? `${linePath(pts)} L${r((pts[0]?.x ?? 0) + 0.01)} ${r(pts[0]?.y ?? 0)}`
        : linePath(pts);
    body = `<path d="${d}" fill="none" stroke="#000" stroke-width="${STROKE}" ${join}/>`;
  } else if (kind === "path" && points.length >= 4) {
    body = `<path d="${linePath(pixels(points, width, height))} Z" ${ink} ${join}/>`;
  } else if (kind === "arc" && points.length >= 5) {
    const [cx, cy, radius, from, to] = points as [number, number, number, number, number];
    const center = { x: unit(cx) * width, y: unit(cy) * height };
    // The radius is a share of the shorter side, so a circle stays round in any box.
    const big = Math.max(0, radius) * Math.min(width, height);
    body = `<path d="${arcPath(center, big, from * 360, sweepOf(from, to), fill)}" ${ink} ${join}/>`;
  }
  return svgDocument(width, height, body);
}
