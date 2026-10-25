import { describe, expect, test } from "bun:test";
import {
  checksSummary,
  classifyFailure,
  parseChecks,
  parseDetail,
  parseLines,
  parsePull,
  parseReference,
  parseReviews,
  parseSearch,
  searchQuery,
  stateOf,
} from "../plugins/github/model";

describe("states", () => {
  test("a merged pull request is merged whatever else it says", () => {
    expect(stateOf("pull", "closed", false, true)).toBe("merged");
  });

  test("a closed item is closed, a draft pull request is a draft, anything else is open", () => {
    expect(stateOf("issue", "closed", false, false)).toBe("closed");
    expect(stateOf("pull", "open", true, false)).toBe("draft");
    expect(stateOf("issue", "open", true, false)).toBe("open");
    expect(stateOf("pull", "open", false, false)).toBe("open");
  });
});

describe("searches", () => {
  test("the query names the repository, the kind, the state and whose items", () => {
    expect(searchQuery("a/b", "issue", { state: "open", mine: false }, "")).toBe("repo:a/b is:issue is:open");
    expect(searchQuery("a/b", "pull", { state: "closed", mine: true }, "  crash on save ")).toBe(
      "repo:a/b is:pr is:closed author:@me crash on save",
    );
  });

  test("a search answer becomes rows with their kind, state and labels", () => {
    const answer = JSON.stringify({
      total: 120,
      items: [
        { number: 1, title: "Issue", state: "open", user: "ada", comments: 0, updated_at: "t", labels: [{ name: "bug", color: "ff0000" }], pull: false },
        { number: 2, title: "Draft", state: "open", draft: true, user: "bob", comments: 4, updated_at: "t", labels: [], pull: true },
        { number: 3, title: "Done", state: "closed", user: "bob", comments: 1, updated_at: "t", labels: [], pull: true, merged: true },
      ],
    });
    const result = parseSearch(answer);
    expect(result.total).toBe(120);
    expect(result.items.map((item) => [item.kind, item.state])).toEqual([
      ["issue", "open"],
      ["pull", "draft"],
      ["pull", "merged"],
    ]);
    expect(result.items[0].labels).toEqual([{ name: "bug", color: "ff0000" }]);
  });

  test("an answer that is not JSON is refused with a sentence", () => {
    expect(() => parseSearch("<html>")).toThrow("not JSON");
  });
});

describe("references", () => {
  test("a number, with or without the hash, names an item of the open repository", () => {
    expect(parseReference("12")).toEqual({ repo: null, number: 12, kind: null });
    expect(parseReference(" #12 ")).toEqual({ repo: null, number: 12, kind: null });
  });

  test("owner/name#number names another repository's item", () => {
    expect(parseReference("neoworks-dev/grove#514")).toEqual({ repo: "neoworks-dev/grove", number: 514, kind: null });
  });

  test("an address says which kind it is", () => {
    expect(parseReference("https://github.com/neoworks-dev/grove/pull/98")).toEqual({ repo: "neoworks-dev/grove", number: 98, kind: "pull" });
    expect(parseReference("https://github.com/neoworks-dev/grove/issues/5#issuecomment-1")).toEqual({
      repo: "neoworks-dev/grove",
      number: 5,
      kind: "issue",
    });
  });

  test("words are not a reference", () => {
    expect(parseReference("crash on save")).toBeNull();
    expect(parseReference("12 crash")).toBeNull();
  });
});

describe("pages", () => {
  test("an issue's page has its body, assignees and address", () => {
    const detail = parseDetail("a/b", {
      number: 4,
      title: "T",
      state: "open",
      body: "Hello",
      user: "ada",
      assignees: ["bob"],
      labels: [],
      comments: 1,
      created_at: "c",
      updated_at: "u",
      html_url: "https://github.com/a/b/issues/4",
    });
    expect(detail).toMatchObject({ kind: "issue", repo: "a/b", body: "Hello", assignees: ["bob"], url: "https://github.com/a/b/issues/4" });
  });

  test("a pull request's page has its branches, commits and size", () => {
    const pull = parsePull("a/b", {
      number: 9,
      title: "P",
      state: "closed",
      merged: true,
      body: null,
      user: "ada",
      assignees: [],
      labels: [],
      comments: 0,
      head: { ref: "feature", sha: "h1" },
      base: { ref: "main", sha: "b1" },
      additions: 10,
      deletions: 2,
      changed_files: 3,
    });
    expect(pull).toMatchObject({ kind: "pull", state: "merged", headBranch: "feature", headSha: "h1", baseBranch: "main", changedFiles: 3, body: "" });
  });

  test("output with one object per line is read line by line, blank lines skipped", () => {
    expect(parseLines('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("checks and reviews", () => {
  test("check runs and commit statuses are one list", () => {
    const checks = parseChecks(
      [
        { name: "build", status: "completed", conclusion: "success", url: "u1" },
        { name: "lint", status: "completed", conclusion: "failure", url: "u2" },
        { name: "e2e", status: "in_progress", conclusion: null, url: "u3" },
        { name: "docs", status: "completed", conclusion: "skipped", url: "u4" },
      ],
      [{ context: "ci/legacy", state: "success", url: "u5" }],
    );
    expect(checks.map((check) => [check.name, check.state])).toEqual([
      ["build", "passing"],
      ["lint", "failing"],
      ["e2e", "pending"],
      ["docs", "skipped"],
      ["ci/legacy", "passing"],
    ]);
  });

  test("the checks add up to the worst of them, and to nothing when there are none", () => {
    expect(checksSummary([])).toBeNull();
    expect(checksSummary(parseChecks([{ name: "a", status: "completed", conclusion: "success" }], []))).toBe("passing");
    expect(
      checksSummary(parseChecks([{ name: "a", status: "completed", conclusion: "success" }, { name: "b", status: "queued" }], [])),
    ).toBe("pending");
    expect(
      checksSummary(parseChecks([{ name: "b", status: "queued" }, { name: "a", status: "completed", conclusion: "timed_out" }], [])),
    ).toBe("failing");
  });

  test("reviews carry their decision in words", () => {
    const reviews = parseReviews([
      { id: 1, user: "ada", state: "APPROVED", body: "", submitted_at: "t" },
      { id: 2, user: "bob", state: "CHANGES_REQUESTED", body: "no", submitted_at: "t" },
      { id: 3, user: "cy", state: "COMMENTED", body: "hm", submitted_at: "t" },
    ]);
    expect(reviews.map((review) => review.state)).toEqual(["approved", "changes requested", "commented"]);
  });
});

describe("failures", () => {
  test("gh's words are grouped by what the person can do", () => {
    expect(classifyFailure("missing", "")).toBe("missing");
    expect(classifyFailure("failed", "To get started with GitHub CLI, please run:  gh auth login")).toBe("unauthenticated");
    expect(classifyFailure("failed", "gh: Bad credentials (HTTP 401)")).toBe("unauthenticated");
    expect(classifyFailure("failed", "none of the git remotes configured for this repository point to a known GitHub host")).toBe("noRemote");
    expect(classifyFailure("failed", "API rate limit exceeded")).toBe("rateLimited");
    expect(classifyFailure("failed", "gh: Not Found (HTTP 404)")).toBe("notFound");
    expect(classifyFailure("failed", "something else")).toBe("failed");
  });
});
