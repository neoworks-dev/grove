import { describe, expect, test } from "bun:test";
import {
  age,
  groupSessions,
  isWithin,
  previewOf,
  sessionTitle,
  siblingsOf,
  withChildren,
  worktreeOf,
  type WorktreePlace,
} from "../plugins/agents/sessions";
import { sessionInfo } from "./support/fakeSuite";

const main: WorktreePlace = { id: "main", name: "repo", path: "/work/repo", branch: "main" };
const feature: WorktreePlace = { id: "feature", name: "feature", path: "/work/repo/.worktrees/feature", branch: "feature" };
const worktrees = [main, feature];

describe("which worktree a directory belongs to", () => {
  test("the deepest worktree that contains it, since the main one contains them all", () => {
    expect(worktreeOf("/work/repo", worktrees)).toBe(main);
    expect(worktreeOf("/work/repo/src/lib", worktrees)).toBe(main);
    expect(worktreeOf("/work/repo/.worktrees/feature", worktrees)).toBe(feature);
    expect(worktreeOf("/work/repo/.worktrees/feature/src", worktrees)).toBe(feature);
  });

  test("none for a directory outside the repository, or one that only shares a prefix", () => {
    expect(worktreeOf("/work/other", worktrees)).toBeNull();
    expect(worktreeOf("/work/repository", worktrees)).toBeNull();
    expect(isWithin("/work/repo/", "/work/repo")).toBe(true);
  });
});

describe("grouping the sessions of the open repository", () => {
  test("groups by worktree, newest first, leaving out sessions elsewhere", () => {
    const groups = groupSessions(
      [
        sessionInfo({ id: "old", cwd: "/work/repo", lastActivity: 1 }),
        sessionInfo({ id: "new", cwd: "/work/repo/src", lastActivity: 5 }),
        sessionInfo({ id: "side", cwd: "/work/repo/.worktrees/feature", lastActivity: 9 }),
        sessionInfo({ id: "away", cwd: "/work/other", lastActivity: 99 }),
      ],
      worktrees,
      "main",
    );
    expect(groups.map((group) => [group.name, group.selected, group.rows.map((row) => row.info.id)])).toEqual([
      ["main", true, ["new", "old"]],
      ["feature", false, ["side"]],
    ]);
  });

  test("the shown worktree comes first even when another has newer sessions", () => {
    const sessions = [
      sessionInfo({ id: "a", cwd: "/work/repo", lastActivity: 1 }),
      sessionInfo({ id: "b", cwd: "/work/repo/.worktrees/feature", lastActivity: 9 }),
    ];
    expect(groupSessions(sessions, worktrees, "feature").map((group) => group.name)).toEqual(["feature", "main"]);
    expect(groupSessions(sessions, worktrees, "main").map((group) => group.name)).toEqual(["main", "feature"]);
  });

  test("the shown worktree is listed without sessions, the others are not", () => {
    const groups = groupSessions([], worktrees, "feature");
    expect(groups.map((group) => [group.name, group.rows.length])).toEqual([["feature", 0]]);
  });

  test("nothing is shown while no worktree is", () => {
    expect(groupSessions([sessionInfo({ id: "a", cwd: "/work/repo" })], [], null)).toEqual([]);
  });

  test("a session another one delegated to follows its parent", () => {
    const rows = withChildren([
      sessionInfo({ id: "child", lastActivity: 9, parent: "parent" }),
      sessionInfo({ id: "other", lastActivity: 5 }),
      sessionInfo({ id: "parent", lastActivity: 1 }),
    ]);
    expect(rows.map((row) => [row.info.id, row.child])).toEqual([
      ["other", false],
      ["parent", false],
      ["child", true],
    ]);
  });
});

describe("what a row says", () => {
  test("the title on one line, else New chat", () => {
    expect(sessionTitle(sessionInfo({ id: "s_0123456789", title: "  Fix\nthe   build " }))).toBe("Fix the build");
    expect(sessionTitle(sessionInfo({ id: "s_0123456789" }))).toBe("New chat");
  });

  test("the preview on one line", () => {
    expect(previewOf(sessionInfo({ id: "a", preview: "one\n two" }))).toBe("one two");
    expect(previewOf(sessionInfo({ id: "a" }))).toBe("");
  });

  test("the age in the largest whole unit", () => {
    expect(age(0, 30_000)).toBe("now");
    expect(age(0, 5 * 60_000)).toBe("5m");
    expect(age(0, 3 * 3_600_000)).toBe("3h");
    expect(age(0, 2 * 86_400_000)).toBe("2d");
    expect(age(10, 0)).toBe("now");
  });
});

describe("the tabs of a pane", () => {
  test("are the sessions of its worktree, in the order the sessions view lists them", () => {
    const groups = groupSessions(
      [
        sessionInfo({ id: "old", cwd: "/work/repo", lastActivity: 1 }),
        sessionInfo({ id: "new", cwd: "/work/repo/src", lastActivity: 5 }),
        sessionInfo({ id: "side", cwd: "/work/repo/.worktrees/feature", lastActivity: 9 }),
      ],
      worktrees,
      "main",
    );
    expect(siblingsOf(groups, "old").map((info) => info.id)).toEqual(["new", "old"]);
    expect(siblingsOf(groups, "side").map((info) => info.id)).toEqual(["side"]);
    expect(siblingsOf(groups, "unknown")).toEqual([]);
  });
});
