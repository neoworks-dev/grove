import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import type { RepoInfo, Worktree } from "../../src/shared/types";
import { WorktreesService } from "../plugins/worktrees/service";
import { bootWorkspace, settle, type Route } from "./support/fakeSidecar";

function worktree(name: string, branch: string, dirty = false): Worktree {
  const path = `/work/${name}`;
  return { id: path, name, path, branch, isMain: name === "repo", isDetached: false, locked: false, dirty, portSlot: 0 };
}

const info: RepoInfo = { path: "/work/repo", name: "repo", currentBranch: "main" };

/** Boots the worktrees service over a repository whose worktree list is `list`, which the routes can change. */
async function bootWorktrees(list: Worktree[], overrides: Record<string, Route> = {}) {
  const harness = await bootWorkspace({
    "repo:open": () => ({ info, worktrees: list }),
    "state:getRepo": () => ({}),
    "state:update": () => undefined,
    "fs:watch": () => undefined,
    "worktrees:list": () => list,
    "worktrees:positions": () => ({ "/work/feature": { base: "main", ahead: 2, behind: 1, mergedLocally: false } }),
    "git:diffStats": (id: unknown) => ({ added: id === "/work/feature" ? 4 : 0, removed: 1, files: [] }),
    "config:load": () => ({ workbench: { default_base_branch: "develop", worktrees_dir: "../.worktrees" } }),
    ...overrides,
  });
  await harness.workspace.open("/work/repo");
  let service!: WorktreesService;
  await harness.root.plugin({
    name: "worktrees",
    inject: ["sidecar", "workspace"],
    apply: (ctx: Context) => void (service = new WorktreesService(ctx)),
  });
  return { ...harness, service };
}

describe("WorktreesService", () => {
  test("reads each branch's position against the base and each worktree's line counts", async () => {
    const { service } = await bootWorktrees([worktree("repo", "main"), worktree("feature", "feature")]);
    await service.refresh();
    expect(service.positionOf("/work/feature")).toMatchObject({ ahead: 2, behind: 1 });
    expect(service.positionOf("/work/repo")).toBeUndefined();
    expect(service.statsOf("/work/feature")?.added).toBe(4);
  });

  test("switching the workspace to a worktree changes the branch the views show", async () => {
    const { workspace } = await bootWorktrees([worktree("repo", "main"), worktree("feature", "feature")]);
    expect(workspace.branch()).toBe("main");
    await workspace.selectWorktree("/work/feature");
    expect(workspace.branch()).toBe("feature");
  });

  test("creating a worktree makes a branch of the same name off the default base and shows it", async () => {
    const list = [worktree("repo", "main")];
    const created = worktree("wt-two", "wt-two");
    const calls: unknown[][] = [];
    const { service, workspace } = await bootWorktrees(list, {
      "worktrees:create": (options: unknown) => {
        calls.push([options]);
        list.push(created);
        return created;
      },
    });
    service.beginCreate();
    expect(service.pending()?.kind).toBe("create");
    expect(await service.commitCreate("wt-two")).toBe(true);
    expect(calls).toEqual([[{ name: "wt-two", baseBranch: "develop", newBranch: "wt-two" }]]);
    expect(workspace.selectedWorktree()?.id).toBe("/work/wt-two");
    expect(workspace.branch()).toBe("wt-two");
  });

  test("a failed create is a notice and leaves the list alone", async () => {
    const { service, workspace } = await bootWorktrees([worktree("repo", "main")], {
      "worktrees:create": () => {
        throw new Error("a branch named wt-two already exists");
      },
    });
    service.beginCreate();
    expect(await service.commitCreate("wt-two")).toBe(false);
    expect(service.notice()).toBe("a branch named wt-two already exists");
    expect(workspace.worktrees()).toHaveLength(1);
  });

  test("removing waits for confirmation, then drops the worktree and its selection", async () => {
    const feature = worktree("feature", "feature", true);
    const list = [worktree("repo", "main"), feature];
    const removed: unknown[][] = [];
    const { service, workspace } = await bootWorktrees(list, {
      "worktrees:remove": (id: unknown, force: unknown) => {
        removed.push([id, force]);
        list.splice(list.indexOf(feature), 1);
        return list;
      },
    });
    await workspace.selectWorktree("/work/feature");
    service.beginRemove(feature);
    expect(removed).toEqual([]);
    expect(await service.confirmRemove()).toBe(true);
    expect(removed).toEqual([["/work/feature", true]]);
    expect(workspace.worktrees().map((entry) => entry.name)).toEqual(["repo"]);
    expect(workspace.selectedWorktree()?.name).toBe("repo");
  });

  test("cancelling a removal removes nothing", async () => {
    const feature = worktree("feature", "feature");
    const { service, link } = await bootWorktrees([worktree("repo", "main"), feature]);
    service.beginRemove(feature);
    service.cancelPending();
    expect(await service.confirmRemove()).toBe(false);
    expect(link.channelsCalled()).not.toContain("worktrees:remove");
  });

  test("a file system event schedules one refresh of the worktrees", async () => {
    const { link } = await bootWorktrees([worktree("repo", "main")]);
    link.calls.length = 0;
    for (let count = 0; count < 3; count += 1) {
      link.emit("event:fs-change", { worktreeId: "/work/repo", path: "x", relPath: "x", type: "change" });
    }
    await settle(700);
    expect(link.channelsCalled().filter((channel) => channel === "worktrees:list")).toHaveLength(1);
  });
});
