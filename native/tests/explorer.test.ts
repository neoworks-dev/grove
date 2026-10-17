import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import type { DiffFile, FileNode, RepoInfo, Worktree } from "../../src/shared/types";
import { ExplorerService } from "../plugins/explorer/service";
import { bootWorkspace, settle, type Harness, type Route } from "./support/fakeSidecar";

const root: Worktree = {
  id: "/work/repo",
  name: "repo",
  path: "/work/repo",
  branch: "main",
  isMain: true,
  isDetached: false,
  locked: false,
  dirty: false,
  portSlot: 0,
};
const info: RepoInfo = { path: "/work/repo", name: "repo", currentBranch: "main" };

/** A file system in memory that answers `files:*` and `git:changedFiles` like the sidecar does. */
class FakeFiles {
  paths = new Set<string>(["src/", "src/index.ts", "src/lib/", "src/lib/util.ts", "README.md"]);
  changed: DiffFile[] = [{ path: "src/index.ts", changeType: "modified", staged: false }];
  listings: string[] = [];

  listDir = (worktreeId: unknown, rel: unknown): FileNode[] => {
    const directory = rel as string;
    this.listings.push(directory);
    const prefix = directory === "" ? "" : `${directory}/`;
    const nodes: FileNode[] = [];
    for (const entry of this.paths) {
      const bare = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      const inside = bare.startsWith(prefix) && !bare.slice(prefix.length).includes("/") && bare !== directory;
      if (!inside) {
        continue;
      }
      nodes.push({ name: bare.slice(prefix.length), relPath: bare, path: `/work/repo/${bare}`, isDir: entry.endsWith("/") });
    }
    return nodes;
  };

  routes() {
    return {
      "repo:open": () => ({ info, worktrees: [root] }),
      "state:getRepo": () => ({}),
      "state:update": () => undefined,
      "fs:watch": () => undefined,
      "files:listDir": this.listDir,
      "git:changedFiles": () => this.changed,
      "files:create": (_worktree: unknown, rel: unknown) => void this.paths.add(rel as string),
      "files:createDir": (_worktree: unknown, rel: unknown) => void this.paths.add(`${rel as string}/`),
      "files:rename": (_worktree: unknown, from: unknown, to: unknown) => {
        this.paths.delete(from as string);
        this.paths.add(to as string);
      },
      "files:delete": (_worktree: unknown, rel: unknown) => void this.paths.delete(rel as string),
    };
  }
}

interface Explorer {
  harness: Harness;
  service: ExplorerService;
  files: FakeFiles;
  opened: string[];
}

/** The explorer over a fake file system, with the workspace on the root worktree. `overrides` replace routes. */
async function bootExplorer(overrides: Record<string, Route> = {}): Promise<Explorer> {
  const files = new FakeFiles();
  const harness = await bootWorkspace({ ...files.routes(), ...overrides });
  await harness.workspace.open("/work/repo");
  const opened: string[] = [];
  let service!: ExplorerService;
  await harness.root.plugin({
    name: "explorer",
    inject: ["sidecar", "workspace"],
    apply(ctx: Context) {
      service = new ExplorerService(ctx, { openInEditor: (path) => void opened.push(path) });
    },
  });
  return { harness, service, files, opened };
}

describe("ExplorerService listing", () => {
  test("shows the root sorted with folders first, and its git changes", async () => {
    const { service } = await bootExplorer();
    await service.show("/work/repo");
    expect(service.roots().map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(service.status()).toBe("ready");
    expect(service.changeOf("src/index.ts")).toBe("modified");
    expect(service.changeOf("README.md")).toBeUndefined();
  });

  test("lists a folder only when it is first opened", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    expect(service.childrenOf(service.roots()[0])).toBeUndefined();
    await service.ensureLoaded("src");
    await service.ensureLoaded("src");
    expect(files.listings).toEqual(["", "src"]);
    expect(service.childrenOf(service.roots()[0])?.map((node) => node.name)).toEqual(["lib", "index.ts"]);
  });

  test("marks the folders that hold a change", async () => {
    const { service } = await bootExplorer();
    await service.show("/work/repo");
    expect([...service.markedDirectories(new Set())]).toEqual(["src"]);
  });

  test("another worktree starts from nothing", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    files.paths = new Set(["other.txt"]);
    files.changed = [];
    await service.show("/work/other");
    expect(service.roots().map((node) => node.name)).toEqual(["other.txt"]);
    expect(service.changeOf("src/index.ts")).toBeUndefined();
  });

  test("the same worktree shown again reads again", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    files.paths.add("added.ts");
    await service.show("/work/repo");
    expect(service.roots().map((node) => node.name)).toContain("added.ts");
  });

  test("a sidecar that is down is a status of its own", async () => {
    const { service, harness } = await bootExplorer();
    await service.show("/work/repo");
    harness.link.exit("gone");
    expect(service.status()).toBe("sidecar-down");
  });

  test("a root that cannot be listed is a failure with the sidecar's message", async () => {
    const { service } = await bootExplorer({
      "files:listDir": () => {
        throw new Error("EACCES: permission denied");
      },
    });
    await service.show("/work/repo");
    expect(service.status()).toBe("failed");
    expect(service.error()).toBe("EACCES: permission denied");
  });
});

describe("ExplorerService live updates", () => {
  test("a file made outside the app appears after the watcher reports it", async () => {
    const { service, files, harness } = await bootExplorer();
    await service.show("/work/repo");
    files.paths.add("made-outside.ts");
    harness.link.emit("event:fs-change", { worktreeId: "/work/repo", path: "/work/repo/made-outside.ts", relPath: "made-outside.ts", type: "add" });
    await settle(250);
    expect(service.roots().map((node) => node.name)).toContain("made-outside.ts");
  });

  test("a burst of events is read once", async () => {
    const { service, files, harness } = await bootExplorer();
    await service.show("/work/repo");
    files.listings.length = 0;
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      files.paths.add(name);
      harness.link.emit("event:fs-change", { worktreeId: "/work/repo", path: name, relPath: name, type: "add" });
    }
    await settle(250);
    expect(files.listings).toEqual([""]);
  });

  test("an edit to a file refreshes git markers without listing again", async () => {
    const { service, files, harness } = await bootExplorer();
    await service.show("/work/repo");
    files.listings.length = 0;
    files.changed = [{ path: "README.md", changeType: "modified", staged: false }];
    harness.link.emit("event:fs-change", { worktreeId: "/work/repo", path: "README.md", relPath: "README.md", type: "change" });
    await settle(250);
    expect(files.listings).toEqual([]);
    expect(service.changeOf("README.md")).toBe("modified");
    expect(service.changeOf("src/index.ts")).toBeUndefined();
  });

  test("events for another worktree are ignored", async () => {
    const { service, files, harness } = await bootExplorer();
    await service.show("/work/repo");
    files.paths.add("elsewhere.ts");
    harness.link.emit("event:fs-change", { worktreeId: "/work/other", path: "x", relPath: "elsewhere.ts", type: "add" });
    await settle(250);
    expect(service.roots().map((node) => node.name)).not.toContain("elsewhere.ts");
  });
});

describe("ExplorerService edits", () => {
  test("creates a file in a folder and answers its path", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    service.beginCreate("create-file", "src");
    expect(service.pending()?.kind).toBe("create-file");
    expect(await service.commitPending("new.ts")).toBe("src/new.ts");
    expect(files.paths.has("src/new.ts")).toBe(true);
    expect(service.pending()).toBeNull();
  });

  test("creates a folder at the root", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    service.beginCreate("create-directory", "");
    expect(await service.commitPending("docs")).toBe("docs");
    expect(files.paths.has("docs/")).toBe(true);
    expect(service.roots().map((node) => node.name)).toContain("docs");
  });

  test("an empty name creates nothing", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    service.beginCreate("create-file", "");
    expect(await service.commitPending("   ")).toBeNull();
    expect(files.paths.size).toBe(5);
  });

  test("renames in place", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    service.beginRename(service.nodeAt("README.md") as FileNode);
    expect(service.pending()?.initialName).toBe("README.md");
    expect(await service.commitPending("READ-ME.md")).toBe("READ-ME.md");
    expect(files.paths.has("README.md")).toBe(false);
    expect(files.paths.has("READ-ME.md")).toBe(true);
  });

  test("deletes only after it is confirmed", async () => {
    const { service, files } = await bootExplorer();
    await service.show("/work/repo");
    service.beginDelete(service.nodeAt("README.md") as FileNode);
    expect(files.paths.has("README.md")).toBe(true);
    service.cancelPending();
    expect(files.paths.has("README.md")).toBe(true);
    service.beginDelete(service.nodeAt("README.md") as FileNode);
    await service.commitPending("");
    expect(files.paths.has("README.md")).toBe(false);
    expect(service.roots().map((node) => node.name)).toEqual(["src"]);
  });

  test("a failed edit is kept as a notice, and the tree stays", async () => {
    const { service } = await bootExplorer({
      "files:create": () => {
        throw new Error("EEXIST: file already exists");
      },
    });
    await service.show("/work/repo");
    service.beginCreate("create-file", "");
    expect(await service.commitPending("README.md")).toBeNull();
    expect(service.notice()).toBe("EEXIST: file already exists");
    expect(service.status()).toBe("ready");
    service.clearNotice();
    expect(service.notice()).toBeNull();
  });
});

describe("ExplorerService.openFile", () => {
  test("hands the file's absolute path to the editor", async () => {
    const { service, opened } = await bootExplorer();
    await service.show("/work/repo");
    service.openFile(service.nodeAt("README.md") as FileNode);
    expect(opened).toEqual(["/work/repo/README.md"]);
  });
});
