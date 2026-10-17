import { describe, expect, test } from "bun:test";
import { baseLabel, hunkAtRow, hunkPosition, sameRequest, stepHunkRow, type Hunk } from "../plugins/diff/model";

const hunks: Hunk[] = [
  { oldStart: 2, oldLen: 1, newStart: 2, newLen: 1 },
  { oldStart: 8, oldLen: 2, newStart: 8, newLen: 0 },
  { oldStart: 20, oldLen: 0, newStart: 20, newLen: 3 },
];

describe("finding a hunk", () => {
  test("a row inside a hunk belongs to it, and a deletion belongs to the row after it", () => {
    expect(hunkAtRow(hunks, 2)).toBe(hunks[0]);
    expect(hunkAtRow(hunks, 8)).toBe(hunks[1]);
    expect(hunkAtRow(hunks, 22)).toBe(hunks[2]);
    expect(hunkAtRow(hunks, 3)).toBeNull();
    expect(hunkAtRow(hunks, 23)).toBeNull();
  });
});

describe("stepping between hunks", () => {
  test("next goes to the first hunk after the row and wraps to the first", () => {
    expect(stepHunkRow(hunks, 0, 1)).toBe(2);
    expect(stepHunkRow(hunks, 2, 1)).toBe(8);
    expect(stepHunkRow(hunks, 21, 1)).toBe(2);
    expect(stepHunkRow(hunks, 20, 1)).toBe(2);
  });

  test("previous goes to the hunk before the one the row is in and wraps to the last", () => {
    expect(stepHunkRow(hunks, 9, 1)).toBe(20);
    expect(stepHunkRow(hunks, 9, -1)).toBe(8);
    expect(stepHunkRow(hunks, 22, -1)).toBe(8);
    expect(stepHunkRow(hunks, 8, -1)).toBe(2);
    expect(stepHunkRow(hunks, 2, -1)).toBe(20);
  });

  test("there is nowhere to go without hunks", () => {
    expect(stepHunkRow([], 4, 1)).toBeNull();
    expect(stepHunkRow([], 4, -1)).toBeNull();
  });
});

describe("the header's words", () => {
  test("say where the cursor is among the changes", () => {
    expect(hunkPosition(hunks, 8)).toBe("2 of 3");
    expect(hunkPosition(hunks, 5)).toBe("3 changes");
    expect(hunkPosition([], 0)).toBe("No changes");
  });

  test("name the base", () => {
    expect(baseLabel("head")).toBe("HEAD");
    expect(baseLabel("index")).toBe("Index");
    expect(baseLabel("staged")).toBe("Staged");
    expect(baseLabel({ text: "x", label: "Before the agent" })).toBe("Before the agent");
  });
});

describe("telling requests apart", () => {
  test("the same file against the same base is the same diff", () => {
    const head = { kind: "file", path: "/a.rs", base: "head" } as const;
    expect(sameRequest(head, { kind: "file", path: "/a.rs", base: "head" })).toBe(true);
    expect(sameRequest(head, { kind: "file", path: "/a.rs", base: "index" })).toBe(false);
    expect(sameRequest(head, { kind: "file", path: "/b.rs", base: "head" })).toBe(false);
    expect(sameRequest(head, { kind: "texts", name: "a.rs", label: "x", oldText: "", newText: "" })).toBe(false);
  });
});
