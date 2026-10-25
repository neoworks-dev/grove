import { describe, expect, test } from "bun:test";
import { GithubClient, GithubError, type GhAnswer, type GhRunner } from "../plugins/github/client";

/** A fake `gh` that records every run and answers each from a function of its arguments. */
function fakeGh(answer: (args: string[]) => GhAnswer): { run: GhRunner; calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  const run: GhRunner = async (request) => {
    calls.push(request);
    return answer(request.args);
  };
  return { run, calls };
}

/** An answer that printed this text. */
function printed(stdout: string): GhAnswer {
  return { stdout, error: null };
}

/** An answer that failed with this message. */
function failed(message: string, kind: "missing" | "failed" = "failed"): GhAnswer {
  return { stdout: "", error: { kind, message, code: 1 } };
}

describe("access", () => {
  test("a gh that is not installed says so", async () => {
    const fake = fakeGh(() => failed("not installed", "missing"));
    const error = await new GithubClient(fake.run).checkAccess().catch((caught) => caught);
    expect(error).toBeInstanceOf(GithubError);
    expect(error.kind).toBe("missing");
    expect(error.message).toContain("not installed");
  });

  test("a gh nobody is logged in to says to log in", async () => {
    const fake = fakeGh(() => failed("You are not logged into any GitHub hosts. To log in, run: gh auth login"));
    const error = await new GithubClient(fake.run).checkAccess().catch((caught) => caught);
    expect(error.kind).toBe("unauthenticated");
    expect(error.message).toContain("gh auth login");
  });

  test("a login that works is trusted for the next calls, and forgotten when asked", async () => {
    const fake = fakeGh(() => printed("{}"));
    const client = new GithubClient(fake.run);
    await client.checkAccess();
    await client.checkAccess();
    expect(fake.calls).toHaveLength(1);
    client.forgetAccess();
    await client.checkAccess();
    expect(fake.calls).toHaveLength(2);
  });

  test("a call that finds the login gone makes the next one look again", async () => {
    let loggedIn = true;
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      if (loggedIn) {
        return printed('{"total":0,"items":[]}');
      }
      return failed("HTTP 401: Bad credentials");
    });
    const client = new GithubClient(fake.run);
    await client.search("repo:a/b");
    loggedIn = false;
    const error = await client.search("repo:a/b").catch((caught) => caught);
    expect(error.kind).toBe("unauthenticated");
    await client.search("repo:a/b").catch(() => {});
    expect(fake.calls.filter((call) => call.args[0] === "auth")).toHaveLength(2);
  });

  test("a folder without a GitHub remote is told apart from other failures", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return failed("no git remotes found");
    });
    const error = await new GithubClient(fake.run).resolveRepo("/work/tree").catch((caught) => caught);
    expect(error.kind).toBe("noRemote");
  });

  test("the repository is asked of gh in the folder's own directory", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed("neoworks-dev/grove\n");
    });
    expect(await new GithubClient(fake.run).resolveRepo("/work/tree")).toBe("neoworks-dev/grove");
    expect(fake.calls[1].cwd).toBe("/work/tree");
    expect(fake.calls[1].args.slice(0, 2)).toEqual(["repo", "view"]);
  });
});

describe("reading", () => {
  const SEARCH_ANSWER = JSON.stringify({
    total: 3,
    items: [
      { number: 7, title: "A bug", state: "open", user: "ada", comments: 2, updated_at: "2026-10-01T00:00:00Z", labels: [{ name: "bug", color: "d73a4a" }], pull: false },
    ],
  });

  test("a search is a GET of the search endpoint, newest change first, with the query as given", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed(SEARCH_ANSWER);
    });
    const result = await new GithubClient(fake.run).search("repo:a/b is:issue is:open");
    const args = fake.calls[1].args;
    expect(args.slice(0, 4)).toEqual(["api", "search/issues", "-X", "GET"]);
    expect(args).toContain("q=repo:a/b is:issue is:open");
    expect(args).toContain("sort=updated");
    expect(result.total).toBe(3);
    expect(result.items[0].title).toBe("A bug");
  });

  test("list endpoints are paged, with their parameters in the path so the call stays a GET", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed('{"filename":"a.ts","status":"added","additions":1,"deletions":0}\n{"filename":"b.ts","status":"removed","additions":0,"deletions":3}\n');
    });
    const files = await new GithubClient(fake.run).fetchFiles("a/b", 9);
    const args = fake.calls[1].args;
    expect(args[1]).toBe("repos/a/b/pulls/9/files?per_page=100");
    expect(args).toContain("--paginate");
    expect(args).not.toContain("-f");
    expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("a file's text is fetched raw at a commit, with each part of its path encoded", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed("line\n");
    });
    expect(await new GithubClient(fake.run).fetchFileText("a/b", "src/my file.ts", "abc123")).toBe("line\n");
    expect(fake.calls[1].args[1]).toBe("repos/a/b/contents/src/my%20file.ts?ref=abc123");
    expect(fake.calls[1].args).toContain("Accept: application/vnd.github.raw+json");
  });

  test("a file the commit does not have reads as empty", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return failed("gh: Not Found (HTTP 404)");
    });
    expect(await new GithubClient(fake.run).fetchFileText("a/b", "gone.ts", "abc")).toBe("");
  });

  test("a runner that throws becomes a failure, not a crash", async () => {
    const client = new GithubClient(async () => {
      throw new Error("host gone");
    });
    const error = await client.checkAccess().catch((caught) => caught);
    expect(error.kind).toBe("failed");
    expect(error.message).toContain("host gone");
  });
});

describe("writes", () => {
  test("a comment is posted with the body as a field, and read back as the comment GitHub stored", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed('{"id":77,"body":"Line one\\nLine two","created_at":"2026-10-25T10:00:00Z","user":"moritz"}');
    });
    const comment = await new GithubClient(fake.run).postComment("o/r", 5, "Line one\nLine two");
    expect(comment).toEqual({ id: 77, author: "moritz", body: "Line one\nLine two", createdAt: "2026-10-25T10:00:00Z" });
    const write = fake.calls.find((call) => call.args[0] === "api")!.args;
    expect(write.slice(0, 5)).toEqual(["api", "repos/o/r/issues/5/comments", "-X", "POST", "-f"]);
    expect(write[5]).toBe("body=Line one\nLine two");
  });

  test("closing patches the issue's state and returns the page as it is now", async () => {
    const page = { number: 5, title: "T", state: "closed", user: "ada", comments: 0, updated_at: "2026-10-25T10:00:00Z" };
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return printed(JSON.stringify(page));
    });
    const detail = await new GithubClient(fake.run).setItemState("o/r", 5, "closed");
    expect(detail.state).toBe("closed");
    const write = fake.calls.find((call) => call.args[0] === "api")!.args;
    expect(write.slice(0, 6)).toEqual(["api", "repos/o/r/issues/5", "-X", "PATCH", "-f", "state=closed"]);
  });

  test("a write that GitHub refuses fails with the reason", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "auth") {
        return printed("");
      }
      return failed("gh: Resource not accessible by personal access token (HTTP 403)");
    });
    const error = await new GithubClient(fake.run).postComment("o/r", 5, "hi").catch((caught) => caught);
    expect(error).toBeInstanceOf(GithubError);
    expect(error.message).toContain("403");
  });
});
