import { expect, test } from "bun:test";
import type { DiffLine } from "@suite/protocol/types";
import { clip, diffStats, gutterWidth, sideBySide } from "../plugins/agents/chat/diff";

const lines: DiffLine[] = [
  { kind: "hunk", text: "@@ -1,4 +1,4 @@" },
  { kind: "context", text: "one", old: 1, new: 1 },
  { kind: "remove", text: "two", old: 2 },
  { kind: "remove", text: "three", old: 3 },
  { kind: "add", text: "TWO", new: 2 },
  { kind: "context", text: "four", old: 4, new: 3 },
  { kind: "add", text: "five", new: 4 },
];

test("a diff counts its added and removed lines", () => {
  expect(diffStats(lines)).toEqual({ added: 2, removed: 2 });
});

test("a long diff is cut to a preview, but never for a single line", () => {
  expect(clip([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], hidden: 2 });
  expect(clip([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2, 3, 4], hidden: 0 });
});

test("side by side, context is on both sides and a change pairs old with new", () => {
  const rows = sideBySide(lines);
  expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -1,4 +1,4 @@" });
  expect(rows[1]).toEqual({
    kind: "pair",
    left: { kind: "context", no: 1, text: "one" },
    right: { kind: "context", no: 1, text: "one" },
  });
  expect(rows[2]).toEqual({
    kind: "pair",
    left: { kind: "remove", no: 2, text: "two" },
    right: { kind: "add", no: 2, text: "TWO" },
  });
  // "three" was removed with nothing to pair with: the right side stays empty.
  expect(rows[3]).toEqual({
    kind: "pair",
    left: { kind: "remove", no: 3, text: "three" },
    right: undefined,
  });
  expect(rows[4]?.kind).toBe("pair");
  // "five" was added at the end: the left side stays empty.
  expect(rows[5]).toEqual({
    kind: "pair",
    left: undefined,
    right: { kind: "add", no: 4, text: "five" },
  });
  expect(rows).toHaveLength(6);
});

test("a change with the additions first still pairs from the top", () => {
  const rows = sideBySide([
    { kind: "add", text: "b", new: 1 },
    { kind: "remove", text: "a", old: 1 },
  ]);
  expect(rows).toEqual([
    {
      kind: "pair",
      left: { kind: "remove", no: 1, text: "a" },
      right: { kind: "add", no: 1, text: "b" },
    },
  ]);
});

test("the line-number column is as wide as the largest number", () => {
  expect(gutterWidth(lines)).toBe(1);
  expect(gutterWidth([{ kind: "context", text: "", old: 1200, new: 99 }])).toBe(4);
});
