import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../plugins/github/markdown";
import type { PullFile } from "../plugins/github/model";
import { agoOf, commentCount, labelColors } from "../plugins/github/present";
import { changeOf, pullFileTree } from "../plugins/github/tree";

/** A changed file. */
function file(path: string, status: PullFile["status"] = "modified"): PullFile {
  return { path, status, additions: 1, deletions: 0, previousPath: null };
}

describe("markdown", () => {
  test("headings, paragraphs with styled runs, lists and code become the chat's blocks", () => {
    const blocks = parseMarkdown("## Plan\n\nRun **fast** and `safe`, see [docs](https://a.b).\n\n- one\n- [x] two\n\n```ts\nlet a = 1\n```\n");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "code_block"]);
    const paragraph = blocks[1] as { spans: { text: string; bold?: boolean; code?: boolean; href?: string }[] };
    expect(paragraph.spans.find((span) => span.bold)?.text).toBe("fast");
    expect(paragraph.spans.find((span) => span.code)?.text).toBe("safe");
    expect(paragraph.spans.find((span) => span.href)?.href).toBe("https://a.b");
    const list = blocks[2] as { items: { checked?: boolean }[] };
    expect(list.items.map((item) => item.checked)).toEqual([undefined, true]);
  });

  test("the HTML comments of an issue template draw nothing", () => {
    const blocks = parseMarkdown("<!-- Describe the bug -->\n\nIt crashes.\n\n<!--\nmulti\nline\n-->\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  test("an image is its description in brackets, and windows line breaks are no problem", () => {
    const blocks = parseMarkdown("![screenshot](https://a.b/x.png)\r\n\r\nNext\r\n");
    const first = blocks[0] as { spans: { text: string }[] };
    expect(first.spans[0].text).toBe("[image: screenshot]");
    expect(blocks).toHaveLength(2);
  });

  test("an empty text is no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("the files of a pull request", () => {
  test("they are the explorer's tree, folders first, with the single-child folders folded", () => {
    const tree = pullFileTree([file("src/main/a.ts"), file("src/main/b.ts", "added"), file("README.md"), file("src/main/deep/c.ts", "removed")]);
    expect(tree.map((node) => node.name)).toEqual(["src/main", "README.md"]);
    const main = tree[0];
    expect(main.children.map((node) => node.name)).toEqual(["deep", "a.ts", "b.ts"]);
    expect(main.children[1].item?.path).toBe("src/main/a.ts");
  });

  test("a status is drawn as the git change of the same meaning", () => {
    expect(changeOf("removed")).toBe("deleted");
    expect(changeOf("added")).toBe("added");
    expect(changeOf("renamed")).toBe("renamed");
    expect(changeOf("modified")).toBe("modified");
  });

  test("a file carries its change, so the tree colours it", () => {
    const tree = pullFileTree([file("a.ts", "added")]);
    expect(tree[0].change).toBe("added");
  });
});

describe("words and colours", () => {
  test("a time is how long ago it was, and nothing when it is not a time", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(agoOf("2026-10-25T09:00:00Z", now)).toBe("3 hours ago");
    expect(agoOf("not a time", now)).toBe("");
  });

  test("comments are counted in the singular and the plural", () => {
    expect(commentCount(0)).toBe("0 comments");
    expect(commentCount(1)).toBe("1 comment");
    expect(commentCount(7)).toBe("7 comments");
  });

  test("a label is its own colour on a faint wash of it, and a colour too dark to read falls back", () => {
    expect(labelColors("d73a4a", "#999999")).toEqual({ text: "#d73a4a", background: "#d73a4a2e" });
    expect(labelColors("0e0e10", "#999999").text).toBe("#999999");
    expect(labelColors("zz", "#999999").text).toBe("#999999");
  });
});
