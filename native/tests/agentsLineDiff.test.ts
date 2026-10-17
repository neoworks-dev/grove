import { expect, test } from "bun:test";
import { diffLinesOf, splitLines } from "../plugins/agents/lineDiff";

test("a text splits into its lines, without the empty one after the last break", () => {
  expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  expect(splitLines("")).toEqual([]);
});

test("a changed line is a removal and an addition with their numbers, among context", () => {
  const lines = diffLinesOf("one\ntwo\nthree\n", "one\n2\nthree\n");
  expect(lines).toEqual([
    { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
    { kind: "context", text: "one", old: 1, new: 1 },
    { kind: "remove", text: "two", old: 2 },
    { kind: "add", text: "2", new: 2 },
    { kind: "context", text: "three", old: 3, new: 3 },
  ]);
});

test("a file the change created is all additions", () => {
  expect(diffLinesOf(undefined, "a\nb\n")).toEqual([
    { kind: "hunk", text: "@@ -1,0 +1,2 @@" },
    { kind: "add", text: "a", new: 1 },
    { kind: "add", text: "b", new: 2 },
  ]);
});

test("identical texts have no lines", () => {
  expect(diffLinesOf("a\nb\n", "a\nb\n")).toEqual([]);
});

test("far apart changes are hunks of their own, each with three lines of context", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const after = before.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n");
  const lines = diffLinesOf(before, after);
  expect(lines.filter((line) => line.kind === "hunk").map((line) => line.text)).toEqual(["@@ -1,5 +1,5 @@", "@@ -25,6 +25,6 @@"]);
  expect(lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["line two", "line twenty-eight"]);
});

test("changes close together share a hunk", () => {
  const before = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n";
  const after = before.replace("l3\n", "x\n").replace("l8\n", "y\n");
  const lines = diffLinesOf(before, after);
  expect(lines.filter((line) => line.kind === "hunk")).toHaveLength(1);
  expect(lines.filter((line) => line.kind === "remove").map((line) => line.text)).toEqual(["l3", "l8"]);
});

test("inserted lines in the middle keep the lines around them as context", () => {
  const lines = diffLinesOf("a\nb\nc\n", "a\nb\nnew\nc\n");
  expect(lines.filter((line) => line.kind === "add")).toEqual([{ kind: "add", text: "new", new: 3 }]);
  expect(lines.filter((line) => line.kind === "remove")).toEqual([]);
});
