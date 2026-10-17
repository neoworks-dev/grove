import { describe, expect, test } from "bun:test";
import type { RepoInfo, Worktree } from "../../src/shared/types";
import { bootWorkspace, settle, type Route } from "./support/fakeSidecar";

function worktree(name: string, path: string, branch: string): Worktree {
  return { id: path, name, path, branch, isMain: false, isDetached: false, locked: false, dirty: false, portSlot: 0 };
}

const main = worktree("repo", "/work/repo", "main");
const feature = worktree("repo-feature", "/work/repo-feature", "feature-x");
const info: RepoInfo = { path: "/work/repo", name: "repo", currentBranch: "main" };

/** Routes for a repository with two worktrees, and a remembered selection if given. */
function routes(selectedWorktreeId: string | null = null, extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "repo:open": (path) => {
      if (path !== "/work/repo") {
        throw new Error(`${path} is not a git repository`);
      }
      return { info, worktrees: [main, feature] };
    },
    "repo:last": () => "/work/repo",
    "state:getRepo": () => ({ selectedWorktreeId }),
    "state:update": () => undefined,
    "fs:watch": () => undefined,
    "worktrees:list": () => [main, feature],
    ...extra,
  };
}

describe("WorkspaceService.open", () => {
  test("holds the repository, its worktrees and the branch of the one at the repository's path", async () => {
    const { workspace } = await bootWorkspace(routes());
    expect(workspace.state()).toBe("none");
    expect(await workspace.open("/work/repo")).toBe(true);
    expect(workspace.state()).toBe("open");
    expect(workspace.repo()).toEqual(info);
    expect(workspace.worktrees().map((entry) => entry.name)).toEqual(["repo", "repo-feature"]);
    expect(workspace.selectedWorktree()?.id).toBe("/work/repo");
    expect(workspace.branch()).toBe("main");
  });

  test("starts on the worktree the repository was left on", async () => {
    const { workspace } = await bootWorkspace(routes("/work/repo-feature"));
    await workspace.open("/work/repo");
    expect(workspace.selectedWorktree()?.id).toBe("/work/repo-feature");
    expect(workspace.branch()).toBe("feature-x");
  });

  test("has the sidecar watch the shown worktree and makes the repository's profile the project layer", async () => {
    const { workspace, link, profile } = await bootWorkspace(routes());
    await workspace.open("/work/repo");
    const watched = link.calls.find((call) => call.channel === "fs:watch");
    expect(watched?.args).toEqual([["/work/repo"]]);
    expect(profile.folders).toEqual(["/work/repo"]);
  });

  test("a path that is not a repository sets the error and leaves the open one alone", async () => {
    const { workspace } = await bootWorkspace(routes());
    await workspace.open("/work/repo");
    expect(await workspace.open("/tmp/nothing")).toBe(false);
    expect(workspace.error()).toBe("/tmp/nothing is not a git repository");
    expect(workspace.state()).toBe("open");
    expect(workspace.repo()).toEqual(info);
  });

  test("a sidecar that is down fails the open the same way", async () => {
    const { workspace, link } = await bootWorkspace(routes());
    link.exit("gone");
    expect(await workspace.open("/work/repo")).toBe(false);
    expect(workspace.error()).toContain("the sidecar is not running");
    expect(workspace.repo()).toBeNull();
  });
});

describe("WorkspaceService.restore", () => {
  test("opens the repository the host names before the last one", async () => {
    const { workspace, link } = await bootWorkspace(routes());
    expect(await workspace.restore("/work/repo")).toBe(true);
    expect(link.channelsCalled()).not.toContain("repo:last");
  });

  test("opens the last repository when the host names none", async () => {
    const { workspace } = await bootWorkspace(routes());
    expect(await workspace.restore("")).toBe(true);
    expect(workspace.repo()?.name).toBe("repo");
  });

  test("opens nothing when there is no last repository", async () => {
    const { workspace } = await bootWorkspace(routes(null, { "repo:last": () => null }));
    expect(await workspace.restore("")).toBe(false);
    expect(workspace.repo()).toBeNull();
    expect(workspace.branch()).toBeNull();
  });

  test("does not throw when the sidecar is down", async () => {
    const { workspace, link } = await bootWorkspace(routes());
    link.exit("gone");
    expect(await workspace.restore("")).toBe(false);
  });
});

describe("WorkspaceService worktrees", () => {
  test("selecting a worktree changes the branch and is remembered", async () => {
    const { workspace, link } = await bootWorkspace(routes());
    await workspace.open("/work/repo");
    await workspace.selectWorktree("/work/repo-feature");
    expect(workspace.branch()).toBe("feature-x");
    const update = link.calls.filter((call) => call.channel === "state:update").pop();
    expect(update?.args).toEqual([{ selectedWorktreeId: "/work/repo-feature" }]);
    const watched = link.calls.filter((call) => call.channel === "fs:watch").pop();
    expect(watched?.args).toEqual([["/work/repo-feature"]]);
  });

  test("selecting a worktree that is not listed does nothing", async () => {
    const { workspace } = await bootWorkspace(routes());
    await workspace.open("/work/repo");
    await workspace.selectWorktree("/elsewhere");
    expect(workspace.selectedWorktree()?.id).toBe("/work/repo");
  });

  test("a worktrees-changed event replaces the list and moves the selection off one that is gone", async () => {
    const { workspace, link } = await bootWorkspace(routes("/work/repo-feature"));
    await workspace.open("/work/repo");
    link.emit("event:worktrees-changed", [main]);
    await settle();
    expect(workspace.worktrees().map((entry) => entry.name)).toEqual(["repo"]);
    expect(workspace.selectedWorktree()?.id).toBe("/work/repo");
  });
});
