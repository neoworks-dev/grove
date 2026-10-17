import { describe, expect, test } from "bun:test";
import type { FileNode } from "../../src/shared/types";
import { ExplorerModel, ancestorsOf, joinPath, parentOf, sortNodes } from "../plugins/explorer/model";

function node(relPath: string, isDir: boolean): FileNode {
  const name = relPath.split("/").pop() as string;
  return { name, relPath, path: `/work/${relPath}`, isDir };
}

describe("paths", () => {
  test("parentOf, joinPath and ancestorsOf", () => {
    expect(parentOf("a/b/c.ts")).toBe("a/b");
    expect(parentOf("c.ts")).toBe("");
    expect(joinPath("", "c.ts")).toBe("c.ts");
    expect(joinPath("a", "c.ts")).toBe("a/c.ts");
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.ts")).toEqual([]);
  });
});

describe("sortNodes", () => {
  test("puts folders first, then orders by name without regard to case", () => {
    const sorted = sortNodes([node("b.ts", false), node("Zed", true), node("A.ts", false), node("alpha", true)]);
    expect(sorted.map((entry) => entry.name)).toEqual(["alpha", "Zed", "A.ts", "b.ts"]);
  });

  test("leaves its input as it was", () => {
    const input = [node("b.ts", false), node("a.ts", false)];
    sortNodes(input);
    expect(input.map((entry) => entry.name)).toEqual(["b.ts", "a.ts"]);
  });
});

describe("ExplorerModel directories", () => {
  test("stores listings sorted and says which have been loaded", () => {
    const model = new ExplorerModel();
    expect(model.hasDirectory("")).toBe(false);
    model.setDirectory("", [node("b.ts", false), node("src", true)]);
    expect(model.children("")?.map((entry) => entry.name)).toEqual(["src", "b.ts"]);
    expect(model.hasDirectory("")).toBe(true);
    expect(model.children("src")).toBeUndefined();
  });

  test("forgetting a directory forgets those under it, not its neighbours", () => {
    const model = new ExplorerModel();
    model.setDirectory("src", []);
    model.setDirectory("src/lib", []);
    model.setDirectory("srcs", []);
    model.forgetDirectory("src");
    expect(model.loadedDirectories()).toEqual(["srcs"]);
  });
});

describe("ExplorerModel git changes", () => {
  test("answers the change of a path", () => {
    const model = new ExplorerModel();
    model.setChanges([
      { path: "src/a.ts", changeType: "modified" },
      { path: "new.ts", changeType: "untracked" },
    ]);
    expect(model.changeOf("src/a.ts")).toBe("modified");
    expect(model.changeOf("new.ts")).toBe("untracked");
    expect(model.changeOf("other.ts")).toBeUndefined();
  });

  test("setting changes again replaces the old ones", () => {
    const model = new ExplorerModel();
    model.setChanges([{ path: "a.ts", changeType: "added" }]);
    model.setChanges([]);
    expect(model.changeOf("a.ts")).toBeUndefined();
  });

  test("a collapsed folder carries the marker of a change inside it", () => {
    const model = new ExplorerModel();
    model.setChanges([{ path: "src/lib/a.ts", changeType: "modified" }]);
    expect([...model.markedDirectories(new Set())]).toEqual(["src"]);
  });

  test("the marker moves down to the deepest folder showing as its ancestors expand", () => {
    const model = new ExplorerModel();
    model.setChanges([{ path: "src/lib/a.ts", changeType: "modified" }]);
    expect([...model.markedDirectories(new Set(["src"]))]).toEqual(["src/lib"]);
    expect([...model.markedDirectories(new Set(["src", "src/lib"]))]).toEqual(["src/lib"]);
  });

  test("a change at the root marks no folder", () => {
    const model = new ExplorerModel();
    model.setChanges([{ path: "README.md", changeType: "modified" }]);
    expect(model.markedDirectories(new Set()).size).toBe(0);
  });
});

describe("ExplorerModel.staleDirectories", () => {
  function loadedModel(): ExplorerModel {
    const model = new ExplorerModel();
    model.setDirectory("", [node("src", true)]);
    model.setDirectory("src", [node("src/a.ts", false)]);
    return model;
  }

  test("a file added in a loaded directory makes that directory stale", () => {
    const model = loadedModel();
    expect(model.staleDirectories({ worktreeId: "w", relPath: "src/b.ts", type: "add" })).toEqual(["src"]);
    expect(model.staleDirectories({ worktreeId: "w", relPath: "c.ts", type: "add" })).toEqual([""]);
  });

  test("a change in a directory that was never loaded makes nothing stale", () => {
    const model = loadedModel();
    expect(model.staleDirectories({ worktreeId: "w", relPath: "docs/x.md", type: "add" })).toEqual([]);
  });

  test("a file's contents changing leaves every listing as it is", () => {
    const model = loadedModel();
    expect(model.staleDirectories({ worktreeId: "w", relPath: "src/a.ts", type: "change" })).toEqual([]);
  });

  test("a removed directory is forgotten and its parent is stale", () => {
    const model = loadedModel();
    expect(model.staleDirectories({ worktreeId: "w", relPath: "src", type: "unlinkDir" })).toEqual([""]);
    expect(model.hasDirectory("src")).toBe(false);
  });
});
