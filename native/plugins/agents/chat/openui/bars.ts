// How a bar chart lays out: whether its bars stand or lie down, how wide they are, what a hover says.
import { fmt } from "./charts";
import { textWidth } from "./layout";

export interface BarSeries {
  name: string;
  values: number[];
}

export interface BarLayout {
  horizontal: boolean;
  /** The range the values span (stacked: the totals), for the axis. */
  min: number;
  max: number;
  /** Width of the labels at the left of lying bars. */
  labelWidth: number;
  /** Width of one bar in a slot of `slot` pixels. */
  bar: (slot: number) => number;
}

/** Room a standing label needs next to its neighbours. */
const LABEL_GAP = 8;

/** How a chart of these series lays out in `width` pixels: lying or standing bars, the axis range and the label width. */
export function barLayout(
  labels: readonly string[],
  series: readonly BarSeries[],
  stacked: boolean,
  horizontal: boolean,
  width: number,
): BarLayout {
  const columns = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
  const totals = Array.from({ length: columns }, (_, index) => {
    const values = series.map((s) => s.values[index] ?? 0);
    return stacked
      ? [
          values.filter((v) => v > 0).reduce((a, b) => a + b, 0),
          values.filter((v) => v < 0).reduce((a, b) => a + b, 0),
        ]
      : values;
  }).flat();
  const widest = Math.max(0, ...labels.map((label) => textWidth(label, 12)));
  const slot = (width - 48) / Math.max(1, labels.length);
  const lie = horizontal || widest + LABEL_GAP > slot;
  const each = Math.max(1, stacked ? 1 : series.length);
  return {
    horizontal: lie,
    min: Math.min(0, ...totals),
    max: Math.max(0, ...totals),
    labelWidth: Math.min(160, Math.max(40, widest + 14)),
    bar: (size) => Math.max(4, Math.min(40, Math.floor((size * 0.7 - 3 * (each - 1)) / each))),
  };
}

/** What hovering a group of bars says: `Jan  Revenue 12 · Costs 9`. */
export function groupTip(label: string, series: readonly BarSeries[], index: number): string {
  const values = series.map((s) => {
    const value = fmt(s.values[index] ?? 0);
    return s.name === "" ? value : `${s.name} ${value}`;
  });
  return `${label}  ${values.join(" · ")}`;
}

/** Show every n-th label of a line chart's axis, so that neighbours do not touch. */
export function labelStep(labels: readonly string[], spacing: number): number {
  const widest = Math.max(0, ...labels.map((label) => textWidth(label, 12))) + 10;
  return Math.max(1, Math.ceil(widest / Math.max(1, spacing)));
}
