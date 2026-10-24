import { describe, expect, test } from "bun:test";
import { buildChangeTree, folderKeysOf, type ChangeTreeNode } from "../plugins/explorer/changeTree";
import { strongerChange } from "../plugins/explorer/model";
import type { DiffChangeType } from "../../src/shared/types";

/** A file to put in a tree, with an item that is its own path. */
function file(path: string, change?: DiffChangeType) {
  return { path, change, item: path };
}

/** A tree as indented names, folders marked with a slash. */
function outline(nodes: ChangeTreeNode<string>[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const label = node.isDir ? `${node.name}/` : node.name;
    return [`${"  ".repeat(depth)}${label}`, ...outline(node.children, depth + 1)];
  });
}

describe("the tree of changed files", () => {
  test("folders come before files, each sorted by name", () => {
    const tree = buildChangeTree([file("z.ts"), file("src/b.ts"), file("src/a.ts"), file("README.md"), file("docs/x.md"), file("docs/y.md")]);
    expect(outline(tree)).toEqual(["docs/", "  x.md", "  y.md", "src/", "  a.ts", "  b.ts", "README.md", "z.ts"]);
  });

  test("a chain of folders with nothing else in them is one row named by the chain", () => {
    const tree = buildChangeTree([file("src/main/ipc/a.ts"), file("src/main/ipc/b.ts"), file("src/main/c.ts")]);
    expect(outline(tree)).toEqual(["src/main/", "  ipc/", "    a.ts", "    b.ts", "  c.ts"]);
    const chain = buildChangeTree([file("native/plugins/agents/Files.svelte")]);
    expect(chain[0]).toMatchObject({ name: "native/plugins/agents", relPath: "native/plugins/agents", isDir: true });
  });

  test("a folder shows the strongest change below it, and a clean file has none", () => {
    const tree = buildChangeTree([file("a/new.ts", "untracked"), file("a/b/old.ts", "modified"), file("a/clean.ts"), file("c/clean.ts")]);
    const folderA = tree.find((node) => node.name === "a")!;
    expect(folderA.change).toBe("modified");
    expect(tree.find((node) => node.name === "c")!.change).toBeUndefined();
    expect(folderA.children.find((node) => node.name === "clean.ts")!.change).toBeUndefined();
  });

  test("keys carry the prefix, so one path in two trees gets two keys", () => {
    const staged = buildChangeTree([file("src/a.ts", "added")], "staged:");
    const unstaged = buildChangeTree([file("src/a.ts", "modified")], "unstaged:");
    expect(staged[0].children[0].key).toBe("staged:src/a.ts");
    expect(unstaged[0].children[0].key).toBe("unstaged:src/a.ts");
    expect(staged[0].children[0].item).toBe("src/a.ts");
  });

  test("lists the keys of every folder to open them", () => {
    const tree = buildChangeTree([file("a/b/c.ts"), file("a/d/e.ts"), file("f.ts")]);
    expect(folderKeysOf(tree)).toEqual(["a", "a/b", "a/d"]);
  });

  test("the stronger of two changes is the one a folder shows", () => {
    expect(strongerChange("untracked", "deleted")).toBe("deleted");
    expect(strongerChange(undefined, "added")).toBe("added");
    expect(strongerChange("modified", undefined)).toBe("modified");
  });
});
