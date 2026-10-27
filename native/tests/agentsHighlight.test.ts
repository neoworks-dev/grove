import { describe, expect, test } from "bun:test";
import { Highlighter, runsOf, styleOf, type HostHighlight } from "../plugins/agents/highlight";
import { highlightDiffLines } from "../plugins/agents/chat/highlightedLines";
import { DARK_SYNTAX } from "../plugins/theme/editorTheme";

const SYNTAX = { keyword: "#a78bfa", string: { color: "#86efac", italic: true }, "function.builtin": "#93c5fd" };

describe("syntax colours for the chat's code", () => {
  test("a name takes its table entry, else its dotted prefix's, else none", () => {
    expect(styleOf("keyword", SYNTAX)).toBe("#a78bfa");
    expect(styleOf("keyword.return", SYNTAX)).toBe("#a78bfa");
    expect(styleOf("function", SYNTAX)).toBeUndefined();
    expect(styleOf("comment", SYNTAX)).toBeUndefined();
  });

  test("a line is cut into the host's runs in their colours, with the text between kept as it is", () => {
    expect(runsOf("const s = 'é'", [[0, 5, "keyword"], [10, 13, "string"]], SYNTAX)).toEqual([
      { text: "const", color: "#a78bfa" },
      { text: " s = " },
      { text: "'é'", color: "#86efac", italic: true },
    ]);
    expect(runsOf("plain", [], SYNTAX)).toEqual([{ text: "plain" }]);
    expect(runsOf("ab", [[0, 9, "keyword"]], SYNTAX)).toEqual([{ text: "ab", color: "#a78bfa" }]);
  });

  test("the host is asked once for a text, an unknown language or a failure is no highlight", async () => {
    let asked = 0;
    const host = async (text: string): Promise<HostHighlight> => {
      asked += 1;
      return { language: "rust", lines: text.split("\n").map(() => [[0, 2, "keyword"]]) };
    };
    const highlighter = new Highlighter(host);
    const first = await highlighter.lines("fn a\nfn b", "x.rs", SYNTAX);
    expect(first?.[1]).toEqual([{ text: "fn", color: "#a78bfa" }, { text: " b" }]);
    await highlighter.lines("fn a\nfn b", "x.rs", SYNTAX);
    expect(asked).toBe(1);
    expect(await new Highlighter(async () => ({ language: null, lines: [] })).lines("x", "x.zzz", SYNTAX)).toBeUndefined();
    expect(await new Highlighter(async () => Promise.reject(new Error("no host"))).lines("x", "x.rs", SYNTAX)).toBeUndefined();
  });

  test("a diff's code lines are highlighted together, and its hunk headers are not", async () => {
    const lines = [
      { kind: "hunk" as const, text: "@@ -1 +1 @@" },
      { kind: "remove" as const, text: "let a = 1", old: 1 },
      { kind: "add" as const, text: "let a = 2", new: 1 },
    ];
    let seen = "";
    const highlighter = new Highlighter(async (text) => {
      seen = text;
      return { language: "rust", lines: [[[0, 3, "keyword"]], [[0, 3, "keyword"]]] };
    });
    const runs = await highlightDiffLines(highlighter, lines, "x.rs", DARK_SYNTAX);
    expect(seen).toBe("let a = 1\nlet a = 2");
    expect(runs?.get(lines[1])?.[0]).toEqual({ text: "let", color: DARK_SYNTAX.keyword as string });
    expect(runs?.has(lines[0])).toBe(false);
    expect(await highlightDiffLines(highlighter, lines, undefined, DARK_SYNTAX)).toBeUndefined();
  });
});
