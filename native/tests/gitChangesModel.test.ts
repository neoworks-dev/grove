import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../src/shared/types";
import { commitHint, diffBaseOf, groupChanges, rowsOf } from "../plugins/git-changes/model";

const files: DiffFile[] = [
  { path: "src/b.rs", changeType: "modified", staged: true },
  { path: "a.md", changeType: "added", staged: true },
  { path: "src/b.rs", changeType: "modified", staged: false },
  { path: "new.txt", changeType: "untracked", staged: false },
  { path: "old.ts", oldPath: "older.ts", changeType: "renamed", staged: false },
];

describe("grouping changes", () => {
  test("splits staged from unstaged and sorts each by path", () => {
    const groups = groupChanges(files);
    expect(groups.staged.map((entry) => entry.path)).toEqual(["a.md", "src/b.rs"]);
    expect(groups.unstaged.map((entry) => entry.path)).toEqual(["new.txt", "old.ts", "src/b.rs"]);
  });

  test("a file with both kinds of change is an entry in each list, under keys that differ", () => {
    const groups = groupChanges(files);
    const staged = groups.staged.find((entry) => entry.path === "src/b.rs");
    const unstaged = groups.unstaged.find((entry) => entry.path === "src/b.rs");
    expect(staged?.key).not.toBe(unstaged?.key);
  });

  test("an entry has the name, the directory and the letter its row shows", () => {
    const entry = groupChanges(files).staged.find((candidate) => candidate.path === "src/b.rs");
    expect(entry).toMatchObject({ name: "b.rs", directory: "src", letter: "M" });
    const root = groupChanges(files).staged.find((candidate) => candidate.path === "a.md");
    expect(root).toMatchObject({ name: "a.md", directory: "", letter: "A" });
    const renamed = groupChanges(files).unstaged.find((candidate) => candidate.path === "old.ts");
    expect(renamed).toMatchObject({ letter: "R", oldPath: "older.ts" });
  });
});

describe("the rows of the list", () => {
  test("each list has a heading with its count, and an empty list has none", () => {
    const rows = rowsOf(groupChanges(files));
    expect(rows.map((row) => (row.kind === "header" ? `${row.title} ${row.count}` : row.entry.name))).toEqual([
      "Staged Changes 2",
      "a.md",
      "b.rs",
      "Changes 3",
      "new.txt",
      "old.ts",
      "b.rs",
    ]);
    expect(rowsOf({ staged: [], unstaged: [] })).toEqual([]);
    const onlyUnstaged = rowsOf(groupChanges([{ path: "x", changeType: "modified", staged: false }]));
    expect(onlyUnstaged[0]).toMatchObject({ kind: "header", id: "unstaged" });
  });
});

describe("what a file's diff compares", () => {
  test("staged changes as they would be committed, unstaged ones against the index, untracked ones with nothing", () => {
    const groups = groupChanges(files);
    expect(diffBaseOf(groups.staged[0])).toBe("staged");
    expect(diffBaseOf(groups.unstaged.find((entry) => entry.path === "src/b.rs")!)).toBe("index");
    expect(diffBaseOf(groups.unstaged.find((entry) => entry.path === "new.txt")!)).toBe("head");
  });
});

describe("the commit button's words", () => {
  test("say what is missing, or what will be committed", () => {
    expect(commitHint(0, "msg", "main")).toBe("Stage changes first");
    expect(commitHint(2, "  ", "main")).toBe("Write a message first");
    expect(commitHint(1, "msg", "main")).toBe("Commit 1 staged file to main (Ctrl+Enter)");
    expect(commitHint(3, "msg", "main")).toBe("Commit 3 staged files to main (Ctrl+Enter)");
  });
});
