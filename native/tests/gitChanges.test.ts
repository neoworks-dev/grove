import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import type { DiffFile, RepoInfo, Worktree } from "../../src/shared/types";
import type { DiffBase } from "../plugins/diff/model";
import { GitChangesService, type ChangesDiffs, type ChangesEditor } from "../plugins/git-changes/service";
import { FakeDiffHost } from "./support/fakeDiffHost";
import { bootWorkspace, settle, type Route } from "./support/fakeSidecar";

const info: RepoInfo = { path: "/work/repo", name: "repo", currentBranch: "main" };
const worktree: Worktree = {
  id: "/work/repo",
  name: "repo",
  path: "/work/repo",
  branch: "main",
  isMain: true,
  isDetached: false,
  locked: false,
  dirty: true,
  portSlot: 0,
};

/** What the service did to the diffs and the editor, and the callbacks it registered. */
interface Spies {
  opened: { path: string; base: DiffBase }[];
  refreshedAll: number;
  reloaded: number[];
  indexListener: () => void;
  filesChanged: () => void;
  openFiles: Map<string, number>;
}

/** A git changes service over a fake sidecar whose git answers from `state`. */
async function setUp(state: { files: DiffFile[] }, overrides: Record<string, Route> = {}) {
  const calls: { channel: string; args: unknown[] }[] = [];
  const record = (channel: string, result: unknown = undefined): Route => {
    return (...args) => {
      calls.push({ channel, args });
      return result;
    };
  };
  const harness = await bootWorkspace({
    "repo:open": () => ({ info, worktrees: [worktree] }),
    "state:getRepo": () => ({}),
    "state:update": () => undefined,
    "fs:watch": () => undefined,
    "git:changedFiles": () => state.files,
    "git:stage": record("git:stage"),
    "git:unstage": record("git:unstage"),
    "git:commit": record("git:commit", "[main abc] message"),
    ...overrides,
  });
  await harness.workspace.open("/work/repo");
  const spies: Spies = {
    opened: [],
    refreshedAll: 0,
    reloaded: [],
    indexListener: () => {},
    filesChanged: () => {},
    openFiles: new Map(),
  };
  const diffs: ChangesDiffs = {
    async showInEditor(path, base) {
      spies.opened.push({ path, base });
      return true;
    },
    async refreshAll() {
      spies.refreshedAll += 1;
    },
    onIndexChanged(listener) {
      spies.indexListener = listener;
      return () => {};
    },
  };
  const editor: ChangesEditor = {
    bufferAt: (path) => {
      const id = spies.openFiles.get(path);
      return id === undefined ? null : { id };
    },
    async reloadDocument(id) {
      spies.reloaded.push(id);
    },
  };
  const diffHost = new FakeDiffHost();
  let service!: GitChangesService;
  await harness.root.plugin({
    name: "git-changes-test",
    inject: ["sidecar", "workspace"],
    apply: (ctx: Context) => {
      service = new GitChangesService(ctx, {
        diffs,
        editor,
        diffHost,
        onFilesChanged: (handler) => {
          spies.filesChanged = handler;
          return () => {};
        },
      });
    },
  });
  await service.refresh();
  return { ...harness, service, spies, calls, diffHost };
}

const changed: DiffFile[] = [
  { path: "a.txt", changeType: "modified", staged: true },
  { path: "b.txt", changeType: "modified", staged: false },
  { path: "dir/c.txt", changeType: "untracked", staged: false },
];

describe("reading the changes", () => {
  test("lists what is staged and what is not for the shown worktree", async () => {
    const { service } = await setUp({ files: changed });
    expect(service.files().staged.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(service.files().unstaged.map((entry) => entry.path)).toEqual(["b.txt", "dir/c.txt"]);
  });

  test("reads again when files change on disk, after a short wait for the burst to end", async () => {
    const state = { files: changed };
    const { service, spies } = await setUp(state);
    state.files = [{ path: "z.txt", changeType: "added", staged: false }];
    spies.filesChanged();
    spies.filesChanged();
    expect(service.files().unstaged).toHaveLength(2);
    await settle(450);
    expect(service.files().unstaged.map((entry) => entry.path)).toEqual(["z.txt"]);
  });

  test("reads again when a hunk was staged from a diff, which the watcher does not see", async () => {
    const state = { files: changed };
    const { service, spies } = await setUp(state);
    state.files = [];
    spies.indexListener();
    await settle(20);
    expect(service.files().staged).toEqual([]);
  });
});

describe("staging", () => {
  test("stages and unstages the files asked for, then reads the changes and the open diffs again", async () => {
    const state = { files: changed };
    const { service, calls, spies } = await setUp(state);
    await service.stage([service.files().unstaged[0]]);
    expect(calls).toEqual([{ channel: "git:stage", args: ["/work/repo", ["b.txt"]] }]);
    expect(spies.refreshedAll).toBe(1);
    await service.unstage(service.files().staged);
    expect(calls[1]).toEqual({ channel: "git:unstage", args: ["/work/repo", ["a.txt"]] });
  });

  test("all of a list at once", async () => {
    const { service, calls } = await setUp({ files: changed });
    await service.stageAll();
    expect(calls[0].args[1]).toEqual(["b.txt", "dir/c.txt"]);
    await service.unstageAll();
    expect(calls[1].args[1]).toEqual(["a.txt"]);
  });

  test("a failure is kept as the notice", async () => {
    const { service } = await setUp({ files: changed }, {
      "git:stage": () => {
        throw new Error("index.lock exists");
      },
    });
    await service.stageAll();
    expect(service.notice()).toBe("index.lock exists");
    service.clearNotice();
    expect(service.notice()).toBe("");
  });
});

describe("committing", () => {
  test("needs something staged and a message", async () => {
    const { service } = await setUp({ files: changed });
    expect(service.canCommit()).toBe(false);
    service.setMessage("  ");
    expect(service.canCommit()).toBe(false);
    service.setMessage("Add things");
    expect(service.canCommit()).toBe(true);
  });

  test("commits with the message, clears it and reads the changes again", async () => {
    const { service, calls } = await setUp({ files: changed });
    service.setMessage("Add things\n");
    expect(await service.commit()).toBe(true);
    expect(calls).toEqual([{ channel: "git:commit", args: ["/work/repo", "Add things"] }]);
    expect(service.message()).toBe("");
  });

  test("with nothing staged it does nothing, and a failed commit keeps the message", async () => {
    const none = await setUp({ files: [{ path: "b.txt", changeType: "modified", staged: false }] });
    none.service.setMessage("x");
    expect(await none.service.commit()).toBe(false);
    expect(none.calls).toEqual([]);
    const failing = await setUp({ files: changed }, {
      "git:commit": () => {
        throw new Error("nothing to commit");
      },
    });
    failing.service.setMessage("x");
    expect(await failing.service.commit()).toBe(false);
    expect(failing.service.message()).toBe("x");
    expect(failing.service.notice()).toBe("nothing to commit");
  });
});

describe("discarding", () => {
  test("asks first, and then throws the changes away and reloads the files that are open", async () => {
    const { service, diffHost, spies } = await setUp({ files: changed });
    spies.openFiles.set("/work/repo/b.txt", 7);
    service.beginDiscard(service.files().unstaged);
    expect(service.pending()?.entries).toHaveLength(2);
    expect(diffHost.discarded).toEqual([]);
    await service.confirmDiscard();
    expect(diffHost.discarded).toEqual([
      [
        { path: "/work/repo/b.txt", untracked: false },
        { path: "/work/repo/dir/c.txt", untracked: true },
      ],
    ]);
    expect(spies.reloaded).toEqual([7]);
    expect(service.pending()).toBeNull();
  });

  test("cancelling leaves everything as it was", async () => {
    const { service, diffHost } = await setUp({ files: changed });
    service.beginDiscard(service.files().unstaged);
    service.cancelDiscard();
    await service.confirmDiscard();
    expect(diffHost.discarded).toEqual([]);
  });
});

describe("opening a file's diff", () => {
  test("staged files as they would be committed, the others against the index", async () => {
    const { service, spies } = await setUp({ files: changed });
    await service.open(service.files().staged[0]);
    await service.open(service.files().unstaged[1]);
    expect(spies.opened).toEqual([
      { path: "/work/repo/a.txt", base: "staged" },
      { path: "/work/repo/dir/c.txt", base: "head" },
    ]);
    expect(service.openedKey()).toBe("unstaged:dir/c.txt");
  });
});
