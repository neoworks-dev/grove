import { describe, expect, test } from "bun:test";
import {
  REANCHOR_WINDOW,
  cardRows,
  commentCount,
  commentableRows,
  commentsByRow,
  newComment,
  placeOf,
  quoteRows,
  reanchor,
  reanchorAll,
  reviewMessage,
  selectionRows,
  wrapText,
  type ReviewComment,
} from "../plugins/review-comments/model";

const FILE = ["one", "two", "three", "four", "five", "six"];

/** A comment on rows of FILE, written at time `at`. */
function commentOn(startRow: number, endRow: number, text = "note", at = 1): ReviewComment {
  return newComment(`c${startRow}-${endRow}-${at}`, "src/a.ts", { startRow, endRow }, quoteRows(FILE, { startRow, endRow }), text, at);
}

describe("which lines can be commented on", () => {
  test("only the rows a hunk changed or added, and a pure deletion has none", () => {
    const hunks = [
      { oldStart: 1, oldLen: 1, newStart: 1, newLen: 2 },
      { oldStart: 5, oldLen: 2, newStart: 6, newLen: 0 },
      { oldStart: 9, oldLen: 0, newStart: 9, newLen: 1 },
    ];
    expect(commentableRows(hunks)).toEqual([1, 2, 9]);
  });
});

describe("the rows a selection covers", () => {
  test("a selection runs from its first row to its last, whichever way it was made", () => {
    expect(selectionRows({ row: 2, column: 4 }, { row: 4, column: 1 })).toEqual({ startRow: 2, endRow: 4 });
    expect(selectionRows({ row: 4, column: 1 }, { row: 2, column: 4 })).toEqual({ startRow: 2, endRow: 4 });
  });

  test("a selection that ends at the start of a line leaves that line out, as selecting whole lines does", () => {
    expect(selectionRows({ row: 2, column: 0 }, { row: 4, column: 0 })).toEqual({ startRow: 2, endRow: 3 });
    expect(selectionRows({ row: 2, column: 3 }, { row: 2, column: 0 })).toEqual({ startRow: 2, endRow: 2 });
  });
});

describe("a comment on lines", () => {
  test("quotes the lines it is on and hangs under the last of them, recording the range", () => {
    const comment = commentOn(1, 3);
    expect(comment.quoted).toEqual(["two", "three", "four"]);
    expect(comment.startRow).toBe(1);
    expect(comment.endRow).toBe(3);
    expect(commentsByRow([comment]).get(3)).toEqual([comment]);
    expect(commentsByRow([comment]).has(1)).toBe(false);
  });

  test("comments under one line keep the order they were written in", () => {
    const later = commentOn(2, 2, "later", 9);
    const earlier = commentOn(2, 2, "earlier", 3);
    expect(commentsByRow([later, earlier]).get(2)?.map((comment) => comment.text)).toEqual(["earlier", "later"]);
  });

  test("is named by its place as people count lines", () => {
    expect(placeOf(commentOn(1, 1))).toBe("src/a.ts:2");
    expect(placeOf(commentOn(1, 3))).toBe("src/a.ts:2-4");
  });

  test("its card is a header and the lines of its text, long ones wrapped at a space", () => {
    expect(cardRows(commentOn(1, 1, "short"))).toBe(2);
    expect(cardRows(commentOn(1, 1, "a\nb\nc"))).toBe(4);
    const long = "word ".repeat(40).trim();
    const lines = wrapText(long, 50);
    expect(lines.length).toBe(4);
    expect(lines.every((line) => line.length <= 50)).toBe(true);
    expect(lines.join(" ")).toBe(long);
  });
});

describe("where a comment goes when the file changes", () => {
  test("stays where it is while its lines are still there", () => {
    const comment = commentOn(2, 2);
    expect(reanchor(comment, FILE)).toEqual(comment);
    expect(reanchorAll([comment], FILE)[0]).toBe(comment);
  });

  test("follows its lines when others are added above them", () => {
    const comment = commentOn(2, 2);
    const moved = reanchor(comment, ["new", "new too", ...FILE]);
    expect(moved.startRow).toBe(4);
    expect(moved.endRow).toBe(4);
    expect(moved.outdated).toBe(false);
  });

  test("follows a range as a whole", () => {
    const comment = commentOn(1, 2);
    const moved = reanchor(comment, ["above", ...FILE]);
    expect([moved.startRow, moved.endRow, moved.outdated]).toEqual([2, 3, false]);
  });

  test("picks the nearest of several equal lines", () => {
    const lines = ["x", "dup", "x", "x", "dup", "x", "x", "x", "dup"];
    const comment = newComment("c", "a.ts", { startRow: 3, endRow: 3 }, ["x"], "note", 1);
    const moved = reanchor({ ...comment, startRow: 5, endRow: 5 }, lines);
    expect(moved.endRow).toBe(5);
    const further = reanchor({ ...comment, startRow: 4, endRow: 4 }, lines);
    expect(further.endRow).toBe(3);
  });

  test("is marked outdated, not dropped, when its line is gone, and stays where it was", () => {
    const comment = commentOn(2, 2);
    const gone = reanchor(comment, ["one", "two", "THREE CHANGED", "four", "five", "six"]);
    expect(gone.outdated).toBe(true);
    expect([gone.startRow, gone.endRow]).toEqual([2, 2]);
    expect(gone.text).toBe(comment.text);
  });

  test("an outdated comment comes back when its line does", () => {
    const outdated = { ...commentOn(2, 2), outdated: true };
    expect(reanchor(outdated, FILE).outdated).toBe(false);
  });

  test("a range survives an edit to one of its other lines by following the last", () => {
    const comment = commentOn(1, 3);
    const moved = reanchor(comment, ["one", "TWO CHANGED", "three", "four", "five", "six"]);
    expect(moved.outdated).toBe(false);
    expect([moved.startRow, moved.endRow]).toEqual([1, 3]);
  });

  test("is kept inside a file that got shorter", () => {
    const comment = commentOn(5, 5);
    const shorter = reanchor(comment, ["one", "two"]);
    expect(shorter.outdated).toBe(true);
    expect(shorter.endRow).toBe(1);
  });

  test("does not look further than the window", () => {
    const comment = commentOn(2, 2);
    const padding = new Array<string>(REANCHOR_WINDOW + 5).fill("filler");
    expect(reanchor(comment, [...padding, "three"]).outdated).toBe(true);
  });

  test("blank lines only match where they were, so a comment on one does not wander", () => {
    const blank = newComment("c", "a.ts", { startRow: 1, endRow: 1 }, [""], "note", 1);
    expect(reanchor(blank, ["a", "", "b"]).outdated).toBe(false);
    expect(reanchor(blank, ["a", "b", "", "c"]).outdated).toBe(true);
  });
});

describe("the review sent to an agent", () => {
  test("lists each comment with its path, its lines, the quoted text and what was said", () => {
    const first = commentOn(1, 1, "Use a constant.", 1);
    const second = { ...commentOn(2, 3, "Both need doc comments.\nAnd tests.", 2), path: "src/b.ts" };
    const message = reviewMessage([second, first]);
    expect(message.text).toBe(
      [
        "Review of your changes: 2 comments on 2 files. Please address each one.",
        "",
        "src/a.ts:2",
        "```",
        "two",
        "```",
        "Use a constant.",
        "",
        "src/b.ts:3-4",
        "```",
        "three",
        "four",
        "```",
        "Both need doc comments.",
        "And tests.",
      ].join("\n"),
    );
  });

  test("the chat is shown a short line in its place", () => {
    const comments = [commentOn(1, 1), commentOn(2, 2), { ...commentOn(3, 3), path: "src/b.ts" }];
    expect(reviewMessage(comments).shown).toBe("Review: 3 comments on 2 files");
    expect(reviewMessage([commentOn(1, 1)]).shown).toBe("Review: 1 comment on 1 file");
  });

  test("says when the file has changed under a comment", () => {
    const message = reviewMessage([{ ...commentOn(1, 1), outdated: true }]);
    expect(message.text).toContain("may have moved or gone");
  });

  test("counts comments", () => {
    expect(commentCount(1)).toBe("1 comment");
    expect(commentCount(0)).toBe("0 comments");
  });
});
