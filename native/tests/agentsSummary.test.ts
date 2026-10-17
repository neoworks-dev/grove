import { expect, test } from "bun:test";
import type { Component } from "@suite/protocol/types";
import { hasButtons } from "../plugins/agents/chat/components";
import { summarize, textLines } from "../plugins/agents/chat/summary";

const code = (text: string): Component => ({ type: "code", code: text });

test("a short result is shown whole", () => {
  expect(summarize(code("a\nb"))).toEqual([{ kind: "code", lines: ["a", "b"] }]);
});

test("a long result is cut after three lines and says how many are left", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  expect(summarize(code(lines))).toEqual([
    { kind: "code", lines: ["line 0", "line 1", "line 2"] },
    { kind: "more", count: 7 },
  ]);
});

test("every part of a result keeps a line before any takes a second", () => {
  const stack: Component = {
    type: "stack",
    children: [
      code("1\n2\n3\n4\n5"),
      { type: "text", blocks: [{ type: "paragraph", spans: [{ text: "Exit code 1" }] }] },
    ],
  };
  const leaves = summarize(stack);
  expect(leaves[0]).toEqual({ kind: "code", lines: ["1", "2"] });
  expect(leaves[1]).toEqual({ kind: "more", count: 3 });
  expect(leaves[2]?.kind).toBe("text");
});

test("a diff is a path with counts, a table its size and columns, a picture costs no line", () => {
  const stack: Component = {
    type: "stack",
    children: [
      { type: "diff", path: "a.ts", lines: [{ kind: "add", text: "x", new: 1 }] },
      {
        type: "table",
        columns: ["a", "b"],
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
      },
      { type: "image", src: "x.png" },
    ],
  };
  const leaves = summarize(stack);
  expect(leaves[0]).toMatchObject({ kind: "diff", path: "a.ts", added: 1, removed: 0 });
  expect(leaves[1]).toEqual({ kind: "line", text: "2 rows · a, b" });
  expect(leaves[2]?.kind).toBe("image");
});

test("markdown flattens to lines with their list markers", () => {
  const lines = textLines([
    { type: "paragraph", spans: [{ text: "intro" }] },
    {
      type: "list",
      ordered: true,
      start: 3,
      items: [
        { blocks: [{ type: "paragraph", spans: [{ text: "x" }] }] },
        { checked: true, blocks: [{ type: "paragraph", spans: [{ text: "y" }] }] },
      ],
    },
    { type: "quote", blocks: [{ type: "paragraph", spans: [{ text: "q" }] }] },
  ]);
  expect(lines.map((l) => l.prefix)).toEqual(["", "3. ", "[x] ", "│ "]);
});

test("a result with buttons is a question", () => {
  const row: Component = {
    type: "row",
    children: [{ type: "button", label: "Allow", action: "a" }],
  };
  expect(hasButtons({ type: "stack", children: [code("x"), row] })).toBe(true);
  expect(hasButtons(code("x"))).toBe(false);
});
