// The arithmetic of the charts: a value axis with round steps, where a bar or a point sits, the
// angles of a pie and the SVG paths that draw lines and slices. The window draws bars with views
// and everything round with `Icon`s, which tint an SVG with one colour, so each series and each
// slice is a path of its own. Plain functions, tested without a window.
import type { NeouiPalette } from "./look";

export interface Scale {
  lo: number;
  hi: number;
  step: number;
  /** The values the axis is marked at, lowest first. */
  ticks: number[];
}

/**
 * An axis from `min` to `max` in round steps (1, 2, 5 times a power of ten), about `target` of
 * them, widened to whole steps. `zero` keeps 0 in range, for bars.
 */
export function niceScale(min: number, max: number, target = 4, zero = false): Scale {
  let lo = zero ? Math.min(0, min) : min;
  let hi = zero ? Math.max(0, max) : max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) {
    // A flat series: room above and below it.
    const room = Math.abs(hi) > 0 ? Math.abs(hi) * 0.5 : 1;
    lo = zero ? Math.min(0, lo) : lo - room;
    hi += room;
  }
  const raw = (hi - lo) / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const step = roundStep(unit) * power;
  const from = Math.floor(lo / step + 1e-9) * step;
  const to = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let at = from; at <= to + step / 2; at += step) ticks.push(Number(at.toFixed(10)));
  return { lo: from, hi: to, step, ticks };
}

/** 1, 2, 5 or 10: the smallest of them that is at least `unit` (a number from 1 to 10). */
function roundStep(unit: number): number {
  return [1, 2, 5].find((step) => unit <= step) ?? 10;
}

/** A number for an axis or a label: whole numbers as they are, long ones as 12.5k. */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  return trim(value);
}

/** A number as the shortest text that keeps two decimals. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** The colour of the n-th series or slice: the theme's accent, success and danger, and mixes of them. */
export function seriesColor(p: NeouiPalette, index: number): string {
  const colors = [
    p.accent,
    p.success,
    p.syntax.constant,
    p.danger,
    p.syntax.keyword,
    p.syntax.type,
  ];
  return colors[index % colors.length] ?? p.accent;
}

/** Where `value` is on a scale of `height` pixels, from the bottom. */
export function heightOf(value: number, scale: Scale, height: number): number {
  const span = scale.hi - scale.lo;
  if (span <= 0) return 0;
  return Math.round(((value - scale.lo) / span) * height * 100) / 100;
}

export interface Point {
  x: number;
  y: number;
}

/** The points of a series across `width`, the first at the left edge and the last at the right. */
export function seriesPoints(
  values: readonly number[],
  scale: Scale,
  width: number,
  height: number,
): Point[] {
  const last = Math.max(1, values.length - 1);
  return values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : (index / last) * width,
    y: height - heightOf(value, scale, height),
  }));
}

const r = (n: number): string => String(Math.round(n * 100) / 100);

/** The SVG path of a line through the points. */
export function linePath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${r(point.x)} ${r(point.y)}`)
    .join(" ");
}

/** The SVG path of the area between a line through the points and the baseline. */
export function areaPath(points: readonly Point[], baseline: number): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return "";
  return `${linePath(points)} L${r(last.x)} ${r(baseline)} L${r(first.x)} ${r(baseline)} Z`;
}

/** An SVG document of `width` by `height` pixels around some shapes. Black: the `Icon` tints it. */
export function svgDocument(width: number, height: number, body: string): string {
  const w = r(width);
  const h = r(height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

/** A line, and with `fill` the area under it down to the baseline. */
export function seriesSvg(
  points: readonly Point[],
  width: number,
  height: number,
  options: { area: boolean; stroke: number },
): string {
  const line = `<path d="${linePath(points)}" fill="none" stroke="#000" stroke-width="${options.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (!options.area) return svgDocument(width, height, line);
  const area = `<path d="${areaPath(points, height)}" fill="#000" fill-opacity="0.22"/>`;
  return svgDocument(width, height, area + line);
}

export interface Slice {
  label: string;
  value: number;
  /** Share of the whole, 0 to 1. */
  share: number;
  /** Degrees clockwise from the top. */
  from: number;
  to: number;
}

/** The slices of a pie: negative values count as nothing, and a pie of nothing has no slices. */
export function pieSlices(items: readonly { label: string; value: number }[]): Slice[] {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0) return [];
  let angle = 0;
  return items.map((item) => {
    const value = Math.max(0, item.value);
    const share = value / total;
    const from = angle;
    angle += share * 360;
    return { label: item.label, value: item.value, share, from, to: angle };
  });
}

/** A percentage as the legend shows it: `42%`, `<1%` for what would round to nothing. */
export function percent(share: number): string {
  const value = share * 100;
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

/** The point at `degrees` on a circle, measured clockwise from the top. */
export function onCircle(cx: number, cy: number, radius: number, degrees: number): Point {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

/** The path of a slice from `from` to `to` degrees; a hole of `inner` pixels makes it a ring segment. */
export function slicePath(
  cx: number,
  cy: number,
  radius: number,
  inner: number,
  from: number,
  to: number,
): string {
  // One arc cannot be a whole circle: two halves.
  const sweep = Math.min(359.99, Math.max(0, to - from));
  const end = from + sweep;
  const large = sweep > 180 ? 1 : 0;
  const a = onCircle(cx, cy, radius, from);
  const b = onCircle(cx, cy, radius, end);
  const outer = `M${r(a.x)} ${r(a.y)} A${r(radius)} ${r(radius)} 0 ${large} 1 ${r(b.x)} ${r(b.y)}`;
  if (inner <= 0) return `${outer} L${r(cx)} ${r(cy)} Z`;
  const c = onCircle(cx, cy, inner, end);
  const d = onCircle(cx, cy, inner, from);
  return `${outer} L${r(c.x)} ${r(c.y)} A${r(inner)} ${r(inner)} 0 ${large} 0 ${r(d.x)} ${r(d.y)} Z`;
}

/** The slice as an SVG document, a box of `size` pixels. */
export function sliceSvg(size: number, inner: number, slice: Slice): string {
  const radius = size / 2;
  const path = slicePath(radius, radius, radius, inner, slice.from, slice.to);
  return svgDocument(size, size, `<path d="${path}" fill="#000"/>`);
}
