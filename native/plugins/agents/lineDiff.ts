// A diff of two texts as the lines the chat draws, for a file an agent touched that git sees no
// difference in (the change was committed since): the tool call's own old and new text are all
// there is to show. The lines have the daemon's shape, hunk headers and numbers included, so the
// same view draws them. Plain functions, so they are tested without a window.

import type { DiffLine } from "@suite/protocol/types";

/** Lines of context kept around a change. */
const CONTEXT = 3;

/** The most cells the table of the middle may have; a larger middle is shown as one replacement. */
const MAX_TABLE_CELLS = 4_000_000;

/** One line of the comparison: kept, removed from the old text, or added by the new one. */
interface Step {
  kind: "context" | "remove" | "add";
  text: string;
}

/** The lines of a text, without the empty one after a final line break. */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The steps that turn `before` into `after`: what the two share is trimmed, and the middle is matched by its longest common run of lines. */
function stepsBetween(before: readonly string[], after: readonly string[]): Step[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const steps: Step[] = before.slice(0, start).map((text) => ({ kind: "context", text }));
  steps.push(...middleSteps(before.slice(start, endBefore), after.slice(start, endAfter)));
  steps.push(...before.slice(endBefore).map((text): Step => ({ kind: "context", text })));
  return steps;
}

/** The steps for the lines that differ, from a table of common run lengths. */
function middleSteps(before: readonly string[], after: readonly string[]): Step[] {
  if (before.length === 0 || after.length === 0 || before.length * after.length > MAX_TABLE_CELLS) {
    return [
      ...before.map((text): Step => ({ kind: "remove", text })),
      ...after.map((text): Step => ({ kind: "add", text })),
    ];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      if (before[row] === after[column]) {
        table[row * width + column] = table[(row + 1) * width + column + 1] + 1;
      } else {
        table[row * width + column] = Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
      }
    }
  }
  const steps: Step[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      steps.push({ kind: "context", text: before[row] });
      row += 1;
      column += 1;
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      steps.push({ kind: "remove", text: before[row] });
      row += 1;
    } else {
      steps.push({ kind: "add", text: after[column] });
      column += 1;
    }
  }
  while (row < before.length) {
    steps.push({ kind: "remove", text: before[row] });
    row += 1;
  }
  while (column < after.length) {
    steps.push({ kind: "add", text: after[column] });
    column += 1;
  }
  return steps;
}

/** The diff from `oldText` (absent for a file the change created) to `newText`, as hunks with three lines of context. */
export function diffLinesOf(oldText: string | undefined, newText: string): DiffLine[] {
  const steps = stepsBetween(splitLines(oldText === undefined ? "" : oldText), splitLines(newText));
  const numbers = lineNumbers(steps);
  const lines: DiffLine[] = [];
  for (const [from, to] of hunkRanges(steps)) {
    lines.push(...hunkLines(steps, numbers, from, to));
  }
  return lines;
}

/** For each step, how many lines of the old text and of the new text come before it. */
function lineNumbers(steps: readonly Step[]): { old: number[]; new: number[] } {
  const old: number[] = [];
  const next: number[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (const step of steps) {
    old.push(oldCount);
    next.push(newCount);
    if (step.kind !== "add") {
      oldCount += 1;
    }
    if (step.kind !== "remove") {
      newCount += 1;
    }
  }
  return { old, new: next };
}

/** The stretches of steps that make up the hunks: each change with its context, joined where the context overlaps. */
function hunkRanges(steps: readonly Step[]): [number, number][] {
  const ranges: [number, number][] = [];
  steps.forEach((step, index) => {
    if (step.kind === "context") {
      return;
    }
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(steps.length, index + CONTEXT + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last[1]) {
      last[1] = Math.max(last[1], to);
      return;
    }
    ranges.push([from, to]);
  });
  return ranges;
}

/** The lines of the hunk made of steps `from` up to `to`: its header, then each step as a line. */
function hunkLines(steps: readonly Step[], numbers: { old: number[]; new: number[] }, from: number, to: number): DiffLine[] {
  const body: DiffLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (let index = from; index < to; index += 1) {
    const step = steps[index];
    const oldLine = numbers.old[index] + 1;
    const newLine = numbers.new[index] + 1;
    if (step.kind === "add") {
      body.push({ kind: "add", text: step.text, new: newLine });
      newCount += 1;
    } else if (step.kind === "remove") {
      body.push({ kind: "remove", text: step.text, old: oldLine });
      oldCount += 1;
    } else {
      body.push({ kind: "context", text: step.text, old: oldLine, new: newLine });
      oldCount += 1;
      newCount += 1;
    }
  }
  const header: DiffLine = {
    kind: "hunk",
    text: `@@ -${numbers.old[from] + 1},${oldCount} +${numbers.new[from] + 1},${newCount} @@`,
  };
  return [header, ...body];
}
