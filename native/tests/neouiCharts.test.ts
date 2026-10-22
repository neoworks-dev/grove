import { expect, test } from "bun:test";
import { barLayout, groupTip, labelStep } from "../plugins/agents/chat/openui/bars";
import {
  areaPath,
  fmt,
  heightOf,
  linePath,
  niceScale,
  percent,
  pieSlices,
  seriesPoints,
  slicePath,
  sliceSvg,
} from "../plugins/agents/chat/openui/charts";

test("an axis has round steps and covers the data", () => {
  expect(niceScale(0, 25, 4, true)).toEqual({ lo: 0, hi: 30, step: 10, ticks: [0, 10, 20, 30] });
  expect(niceScale(0, 355, 4, true).ticks).toEqual([0, 100, 200, 300, 400]);
  expect(niceScale(12, 28, 4).ticks).toEqual([10, 15, 20, 25, 30]);
  expect(niceScale(0.02, 0.07, 4).step).toBe(0.02);
});

test("an axis keeps zero in range for bars and gives a flat series some room", () => {
  const bars = niceScale(5, 9, 4, true);
  expect(bars.lo).toBe(0);
  expect(bars.hi).toBeGreaterThanOrEqual(9);
  const flat = niceScale(7, 7, 4);
  expect(flat.lo).toBeLessThan(7);
  expect(flat.hi).toBeGreaterThan(7);
  expect(niceScale(0, 0, 4, true).hi).toBeGreaterThan(0);
  expect(niceScale(Number.NaN, 3, 4).hi).toBeGreaterThan(niceScale(Number.NaN, 3, 4).lo);
});

test("numbers on an axis are short", () => {
  expect(fmt(12)).toBe("12");
  expect(fmt(0.5)).toBe("0.5");
  expect(fmt(1.23456)).toBe("1.23");
  expect(fmt(12500)).toBe("12.5k");
  expect(fmt(3_000_000)).toBe("3M");
  expect(fmt(-20000)).toBe("-20k");
  expect(fmt(Number.NaN)).toBe("");
});

test("points sit on the axis, the first at the left edge and the last at the right", () => {
  const scale = niceScale(0, 10, 5, true);
  expect(heightOf(5, scale, 100)).toBe(50);
  const points = seriesPoints([0, 10, 5], scale, 200, 100);
  expect(points).toEqual([
    { x: 0, y: 100 },
    { x: 100, y: 0 },
    { x: 200, y: 50 },
  ]);
  // A single value sits in the middle.
  expect(seriesPoints([4], scale, 200, 100)[0]?.x).toBe(100);
  expect(linePath(points)).toBe("M0 100 L100 0 L200 50");
  expect(areaPath(points, 100)).toBe("M0 100 L100 0 L200 50 L200 100 L0 100 Z");
  expect(areaPath([], 100)).toBe("");
});

test("a pie's slices add up to the circle and a pie of nothing has none", () => {
  const slices = pieSlices([
    { label: "a", value: 50 },
    { label: "b", value: 25 },
    { label: "c", value: 25 },
  ]);
  expect(slices.map((s) => s.share)).toEqual([0.5, 0.25, 0.25]);
  expect(slices.map((s) => [s.from, s.to])).toEqual([
    [0, 180],
    [180, 270],
    [270, 360],
  ]);
  expect(pieSlices([{ label: "a", value: 0 }])).toEqual([]);
  expect(
    pieSlices([
      { label: "a", value: -3 },
      { label: "b", value: 1 },
    ]).map((s) => s.share),
  ).toEqual([0, 1]);
  expect(percent(0.424)).toBe("42%");
  expect(percent(0.004)).toBe("<1%");
  expect(percent(0)).toBe("0%");
});

test("a slice is an arc from the top clockwise, a ring segment with a hole, and never a degenerate circle", () => {
  const quarter = slicePath(50, 50, 50, 0, 0, 90);
  expect(quarter).toBe("M50 0 A50 50 0 0 1 100 50 L50 50 Z");
  const ring = slicePath(50, 50, 50, 20, 0, 90);
  expect(ring.startsWith("M50 0 A50 50 0 0 1 100 50 L70 50 A20 20 0 0 0 50 30 Z")).toBe(true);
  expect(slicePath(50, 50, 50, 0, 0, 270)).toContain(" 0 1 1 ");
  // A whole circle stops just short of closing, so the arc has two different ends.
  const whole = slicePath(50, 50, 50, 0, 0, 360);
  expect(whole).not.toContain("A50 50 0 0 1 50 0");
  const svg = sliceSvg(100, 0, { label: "a", value: 1, share: 1, from: 0, to: 360 });
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100"')).toBe(true);
});

test("bars lie down when the labels do not fit under standing bars, or when asked", () => {
  const series = [{ name: "GB", values: [355, 65, 48, 103] }];
  const long = ["Documents", ".cache", "Games", "Other"];
  expect(barLayout(["Q1", "Q2", "Q3", "Q4"], series, false, false, 500).horizontal).toBe(false);
  expect(barLayout(long, series, false, false, 300).horizontal).toBe(true);
  expect(barLayout(["Q1", "Q2"], series, false, true, 900).horizontal).toBe(true);
});

test("stacked bars are scaled by their totals and grouped bars share their slot", () => {
  const series = [
    { name: "A", values: [4, 6] },
    { name: "B", values: [2, 3] },
  ];
  const stacked = barLayout(["x", "y"], series, true, false, 600);
  expect([stacked.min, stacked.max]).toEqual([0, 9]);
  const grouped = barLayout(["x", "y"], series, false, false, 600);
  expect(grouped.max).toBe(6);
  expect(grouped.bar(100)).toBeLessThan(stacked.bar(100));
  expect(stacked.bar(10)).toBeGreaterThanOrEqual(4);
});

test("a hover says the label and each series' value, and axis labels are thinned until they fit", () => {
  const series = [
    { name: "Revenue", values: [12, 15] },
    { name: "", values: [9, 9] },
  ];
  expect(groupTip("Jan", series, 0)).toBe("Jan  Revenue 12 · 9");
  expect(labelStep(["Mon", "Tue"], 100)).toBe(1);
  expect(labelStep(["January", "February", "March"], 30)).toBeGreaterThan(1);
});
