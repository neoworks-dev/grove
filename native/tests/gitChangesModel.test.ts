import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../src/shared/types";
import { commitHint, diffBaseOf, groupChanges, sectionsOf } from "../plugins/git-changes/model";

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

describe("the sections tree", () => {
  test("each list is a heading with its count over its folders, and an empty list has none", () => {
    const sections = sectionsOf(groupChanges(files));
    expect(sections.map((section) => [section.key, section.name, section.section])).toEqual([
      ["staged", "Staged Changes · 2", true],
      ["unstaged", "Changes · 3", true],
    ]);
    expect(sections[0].children.map((node) => node.name)).toEqual(["src", "a.md"]);
    expect(sections[0].children[0].children.map((node) => node.key)).toEqual(["staged:src/b.rs"]);
    expect(sectionsOf({ staged: [], unstaged: [] })).toEqual([]);
    const onlyUnstaged = sectionsOf(groupChanges([{ path: "x", changeType: "modified", staged: false }]));
    expect(onlyUnstaged[0]).toMatchObject({ key: "unstaged", section: true });
  });

  test("a file keeps its entry's key, so the opened file can be found in the tree", () => {
    const groups = groupChanges(files);
    const keys = sectionsOf(groups)[1].children.map((node) => node.key);
    expect(keys).toContain(groups.unstaged.find((entry) => entry.path === "new.txt")!.key);
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
