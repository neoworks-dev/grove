import { describe, expect, test } from "bun:test";
import { Context as RootContext, type Context } from "@neoworks/extension-system";
import type { Worktree } from "../../src/shared/types";
import { GithubClient, type GhAnswer, type GhRunner } from "../plugins/github/client";
import { GITHUB_PANE_TYPE, GithubService, type GithubDiffs } from "../plugins/github/service";
import { LayoutService } from "../plugins/layout/service";
import { settle } from "./support/fakeSidecar";

const REPO = "neoworks-dev/grove";
const FOLDER = "/work/grove";

/** The worktree the workspace shows. */
const WORKTREE = { id: "w1", path: FOLDER, branch: "main" } as Worktree;

/** What a fake `gh` is asked and what it answers, by the first path or command word of the arguments. */
interface FakeGh {
  run: GhRunner;
  /** Every run, in order. */
  calls: string[][];
  /** Answers by a substring of the joined arguments; the longest that matches wins. */
  answers: Map<string, GhAnswer | (() => Promise<GhAnswer>)>;
}

/** A `gh` that answers auth and repository questions itself and the rest from `answers`. */
function fakeGh(): FakeGh {
  const answers = new Map<string, GhAnswer | (() => Promise<GhAnswer>)>();
  const calls: string[][] = [];
  const run: GhRunner = async ({ args }) => {
    calls.push(args);
    const line = args.join(" ");
    if (args[0] === "auth") {
      return { stdout: "", error: null };
    }
    if (args[0] === "repo") {
      return { stdout: `${REPO}\n`, error: null };
    }
    // The most specific answer wins, so a test can set a general one and override part of it.
    const matching = [...answers.keys()].filter((needle) => line.includes(needle)).sort((first, second) => second.length - first.length);
    if (matching.length > 0) {
      const answer = answers.get(matching[0])!;
      if (typeof answer === "function") {
        return answer();
      }
      return answer;
    }
    return { stdout: "", error: { kind: "failed", message: `nothing answers ${line}`, code: 1 } };
  };
  return { run, calls, answers };
}

/** An answer that printed this text. */
function printed(stdout: string): GhAnswer {
  return { stdout, error: null };
}

/** A search answer with one row. */
function searchAnswer(number: number, title: string, pull = false): GhAnswer {
  return printed(
    JSON.stringify({
      total: 1,
      items: [{ number, title, state: "open", user: "ada", comments: 0, updated_at: "2026-10-01T00:00:00Z", labels: [], pull }],
    }),
  );
}

/** The page of an issue or a pull request. */
function pageAnswer(number: number, extra: Record<string, unknown> = {}): GhAnswer {
  return printed(
    JSON.stringify({
      number,
      title: `Item ${number}`,
      state: "open",
      body: "Body text",
      user: "ada",
      assignees: [],
      labels: [],
      comments: 1,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
      html_url: `https://github.com/${REPO}/issues/${number}`,
      ...extra,
    }),
  );
}

interface Setup {
  gh: FakeGh;
  layout: LayoutService;
  github: GithubService;
  shown: { path: string; base: { text: string; label: string } }[];
  opened: { name: string; oldText: string; newText: string; label: string }[];
  /** What HEAD has for a path; a path not in it does not exist there. */
  head: Map<string, string>;
  urls: string[];
}

/** The service over a fake `gh`, a real layout, and fakes for the diffs and the browser. */
async function setUp(): Promise<Setup> {
  const root = new RootContext();
  const gh = fakeGh();
  const setup = { gh, shown: [], opened: [], head: new Map<string, string>(), urls: [] } as unknown as Setup;
  const diffs: GithubDiffs = {
    async showInEditor(path, base) {
      setup.shown.push({ path, base });
      return true;
    },
    async openTexts(name, oldText, newText, label) {
      setup.opened.push({ name, oldText, newText, label });
      return "diff-pane";
    },
    async headText(path) {
      const text = setup.head.get(path);
      if (text === undefined) {
        return { exists: false, text: "" };
      }
      return { exists: true, text };
    },
  };
  await root.plugin({
    name: "github-test",
    apply(ctx: Context) {
      setup.layout = new LayoutService(ctx, "editor", null);
      setup.github = new GithubService(ctx, {
        client: new GithubClient(gh.run),
        workspace: { selectedWorktree: () => WORKTREE, repo: () => null, onSelectionChange: () => () => {} },
        layout: setup.layout,
        diffs,
        openUrl: (url) => setup.urls.push(url),
      });
    },
  });
  return setup;
}

/** The leaf of the only GitHub pane. */
function githubLeaf(setup: Setup): string {
  const leaves = setup.layout.leafIds().filter((leafId) => setup.layout.paneTypeOf(leafId) === GITHUB_PANE_TYPE);
  expect(leaves).toHaveLength(1);
  return leaves[0];
}

/** The `q=` of the last search the fake `gh` was asked. */
function lastQuery(setup: Setup): string {
  const searches = setup.gh.calls.filter((args) => args[1] === "search/issues");
  const last = searches[searches.length - 1];
  return last.find((argument) => argument.startsWith("q="))!.slice(2);
}

describe("lists", () => {
  test("opening the issues makes a GitHub pane and reads the open issues of the folder's repository", async () => {
    const setup = await setUp();
    setup.gh.answers.set("search/issues", searchAnswer(7, "A bug"));
    const leafId = await setup.github.openList("issue");
    expect(leafId).toBe(githubLeaf(setup));
    const view = setup.github.view(leafId!);
    expect(view.repo).toBe(REPO);
    expect(view.list.status).toBe("ready");
    expect(view.list.items.map((item) => item.title)).toEqual(["A bug"]);
    expect(lastQuery(setup)).toBe(`repo:${REPO} is:issue is:open`);
    expect(setup.layout.focusedLeafId).toBe(leafId!);
  });

  test("the pull request list, the closed filter, mine and a search each change the query", async () => {
    const setup = await setUp();
    setup.gh.answers.set("search/issues", searchAnswer(3, "A change", true));
    const leafId = (await setup.github.openList("pull"))!;
    expect(lastQuery(setup)).toBe(`repo:${REPO} is:pr is:open`);
    await setup.github.setFilter(leafId, { state: "closed", mine: true });
    expect(lastQuery(setup)).toBe(`repo:${REPO} is:pr is:closed author:@me`);
    await setup.github.setSearch(leafId, "label:bug crash");
    expect(lastQuery(setup)).toBe(`repo:${REPO} is:pr is:closed author:@me label:bug crash`);
    expect(setup.github.view(leafId).place.search).toBe("label:bug crash");
  });

  test("the commands reuse the GitHub pane that exists instead of making another", async () => {
    const setup = await setUp();
    setup.gh.answers.set("search/issues", searchAnswer(1, "x"));
    await setup.github.openList("issue");
    await setup.github.openList("pull");
    expect(setup.layout.leafIds().filter((leafId) => setup.layout.paneTypeOf(leafId) === GITHUB_PANE_TYPE)).toHaveLength(1);
    expect(setup.github.view(githubLeaf(setup)).place.listKind).toBe("pull");
  });

  test("a search that was overtaken does not replace the newer one", async () => {
    const setup = await setUp();
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    setup.gh.answers.set("search/issues", searchAnswer(1, "first"));
    const leafId = (await setup.github.openList("issue"))!;
    setup.gh.answers.set("q=repo:neoworks-dev/grove is:issue is:open old", async () => {
      await slow;
      return searchAnswer(2, "stale");
    });
    const overtaken = setup.github.setSearch(leafId, "old");
    await settle();
    setup.gh.answers.set("q=repo:neoworks-dev/grove is:issue is:open new", searchAnswer(3, "fresh"));
    await setup.github.setSearch(leafId, "new");
    releaseSlow();
    await overtaken;
    expect(setup.github.view(leafId).list.items.map((item) => item.title)).toEqual(["fresh"]);
  });
});

describe("when GitHub cannot be read", () => {
  test("a login that is missing is shown in place of the list", async () => {
    const setup = await setUp();
    setup.gh.run = async () => ({ stdout: "", error: { kind: "failed", message: "To get started with GitHub CLI, please run:  gh auth login", code: 4 } });
    const root = new RootContext();
    let github!: GithubService;
    await root.plugin({
      name: "unauth",
      apply(ctx: Context) {
        github = new GithubService(ctx, {
          client: new GithubClient(setup.gh.run),
          workspace: { selectedWorktree: () => WORKTREE, repo: () => null, onSelectionChange: () => () => {} },
          layout: setup.layout,
          diffs: { showInEditor: async () => true, openTexts: async () => null, headText: async () => ({ exists: false, text: "" }) },
          openUrl: () => {},
        });
      },
    });
    const leafId = (await github.openList("issue"))!;
    const view = github.view(leafId);
    expect(view.failure?.kind).toBe("unauthenticated");
    expect(view.failure?.message).toContain("gh auth login");
    expect(view.list.items).toEqual([]);
  });

  test("a folder without a GitHub remote says so", async () => {
    const setup = await setUp();
    const run: GhRunner = async ({ args }) => {
      if (args[0] === "repo") {
        return { stdout: "", error: { kind: "failed", message: "no git remotes found", code: 1 } };
      }
      return { stdout: "", error: null };
    };
    const root = new RootContext();
    let github!: GithubService;
    await root.plugin({
      name: "noremote",
      apply(ctx: Context) {
        github = new GithubService(ctx, {
          client: new GithubClient(run),
          workspace: { selectedWorktree: () => WORKTREE, repo: () => null, onSelectionChange: () => () => {} },
          layout: setup.layout,
          diffs: { showInEditor: async () => true, openTexts: async () => null, headText: async () => ({ exists: false, text: "" }) },
          openUrl: () => {},
        });
      },
    });
    const leafId = (await github.openList("pull"))!;
    expect(github.view(leafId).failure?.kind).toBe("noRemote");
  });
});

describe("items", () => {
  test("an issue shows its page and its comments", async () => {
    const setup = await setUp();
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/5/comments", printed('{"id":1,"body":"Me too","created_at":"t","user":"bob"}\n'));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/5 --jq", pageAnswer(5));
    const leafId = (await setup.github.openItem({ repo: null, number: 5, kind: "issue" }))!;
    const item = setup.github.view(leafId).item;
    expect(item.status).toBe("ready");
    expect(item.detail?.title).toBe("Item 5");
    expect(item.extras).toBe("ready");
    expect(item.comments.map((comment) => comment.body)).toEqual(["Me too"]);
    expect(item.files).toEqual([]);
    expect(setup.github.paneTitle(leafId)).toBe("#5");
  });

  test("a pull request also reads its files, reviews and checks", async () => {
    const setup = await setUp();
    const pull = { head: { ref: "feature", sha: "h1" }, base: { ref: "main", sha: "b1" }, merged: false, additions: 3, deletions: 1, changed_files: 1 };
    setup.gh.answers.set("repos/neoworks-dev/grove/pulls/9/files", printed('{"filename":"src/a.ts","status":"modified","additions":3,"deletions":1}\n'));
    setup.gh.answers.set("repos/neoworks-dev/grove/pulls/9/reviews", printed('{"id":1,"user":"cy","state":"APPROVED","body":"","submitted_at":"t"}\n'));
    setup.gh.answers.set("commits/h1/check-runs", printed('{"name":"build","status":"completed","conclusion":"success","url":"u"}\n'));
    setup.gh.answers.set("commits/h1/status", printed(""));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/9/comments", printed(""));
    setup.gh.answers.set("repos/neoworks-dev/grove/pulls/9 --jq", pageAnswer(9, { pull_request: {}, ...pull }));
    const leafId = (await setup.github.openItem({ repo: null, number: 9, kind: "pull" }))!;
    const item = setup.github.view(leafId).item;
    expect(item.detail?.kind).toBe("pull");
    expect(item.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(item.reviews.map((review) => review.state)).toEqual(["approved"]);
    expect(item.checks.map((check) => check.state)).toEqual(["passing"]);
  });

  test("a number typed without a kind is looked up, and a pull request is read as one", async () => {
    const setup = await setUp();
    const pull = { pull: true, head: { ref: "f", sha: "h" }, base: { ref: "main", sha: "b" } };
    setup.gh.answers.set("issues/12/comments", printed(""));
    setup.gh.answers.set("pulls/12/files", printed(""));
    setup.gh.answers.set("pulls/12/reviews", printed(""));
    setup.gh.answers.set("commits/h/check-runs", printed(""));
    setup.gh.answers.set("commits/h/status", printed(""));
    setup.gh.answers.set("repos/neoworks-dev/grove/pulls/12 --jq", pageAnswer(12, pull));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/12 --jq", pageAnswer(12, pull));
    const leafId = (await setup.github.openItem({ repo: null, number: 12, kind: null }))!;
    const view = setup.github.view(leafId);
    expect(view.item.detail?.kind).toBe("pull");
    expect(view.place.item).toEqual({ kind: "pull", number: 12 });
  });

  test("an item of another repository is read from it, whatever folder is open", async () => {
    const setup = await setUp();
    setup.gh.answers.set("issues/3/comments", printed(""));
    setup.gh.answers.set("repos/other/thing/issues/3 --jq", pageAnswer(3));
    const leafId = (await setup.github.openItem({ repo: "other/thing", number: 3, kind: "issue" }))!;
    expect(setup.github.view(leafId).repo).toBe("other/thing");
    expect(setup.github.view(leafId).item.status).toBe("ready");
    expect(setup.gh.calls.some((args) => args[0] === "repo")).toBe(false);
  });

  test("an item that does not exist says so", async () => {
    const setup = await setUp();
    setup.gh.answers.set("issues/404 --jq", { stdout: "", error: { kind: "failed", message: "gh: Not Found (HTTP 404)", code: 1 } });
    const leafId = (await setup.github.openItem({ repo: null, number: 404, kind: "issue" }))!;
    const item = setup.github.view(leafId).item;
    expect(item.status).toBe("error");
    expect(item.message).toContain("nothing at that address");
  });

  test("back returns to the list, which is read if the pane opened straight on the item", async () => {
    const setup = await setUp();
    setup.gh.answers.set("issues/5/comments", printed(""));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/5 --jq", pageAnswer(5));
    setup.gh.answers.set("search/issues", searchAnswer(5, "Item 5"));
    const leafId = (await setup.github.openItem({ repo: null, number: 5, kind: "issue" }))!;
    await setup.github.back(leafId);
    const view = setup.github.view(leafId);
    expect(view.place.view).toBe("list");
    expect(view.list.items.map((item) => item.title)).toEqual(["Item 5"]);
  });

  test("a pane restored with its place reads what it shows when it appears", async () => {
    const setup = await setUp();
    setup.gh.answers.set("search/issues", searchAnswer(1, "x"));
    setup.layout.splitFocused("row", GITHUB_PANE_TYPE);
    const leafId = githubLeaf(setup);
    setup.layout.setPaneState(leafId, { github: { repo: null, view: "list", listKind: "pull", filter: { state: "closed", mine: false }, search: "", item: null } });
    await setup.github.ensureLoaded(leafId);
    expect(lastQuery(setup)).toBe(`repo:${REPO} is:pr is:closed`);
  });

  test("the browser button opens the item's page", async () => {
    const setup = await setUp();
    setup.gh.answers.set("issues/5/comments", printed(""));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/5 --jq", pageAnswer(5));
    const leafId = (await setup.github.openItem({ repo: null, number: 5, kind: "issue" }))!;
    setup.github.openInBrowser(leafId);
    expect(setup.urls).toEqual([`https://github.com/${REPO}/issues/5`]);
  });
});

describe("a pull request's files", () => {
  /** A pull request page read into a pane, with its merge base and file texts answered. */
  async function pullPane(setup: Setup): Promise<string> {
    const pull = { pull: true, head: { ref: "f", sha: "headsha" }, base: { ref: "main", sha: "basesha" } };
    setup.gh.answers.set("issues/9/comments", printed(""));
    setup.gh.answers.set("pulls/9/files", printed('{"filename":"src/a.ts","status":"modified","additions":1,"deletions":1}\n'));
    setup.gh.answers.set("pulls/9/reviews", printed(""));
    setup.gh.answers.set("commits/headsha/check-runs", printed(""));
    setup.gh.answers.set("commits/headsha/status", printed(""));
    setup.gh.answers.set("compare/basesha...headsha", printed("mergebase\n"));
    setup.gh.answers.set("contents/src/a.ts?ref=mergebase", printed("old text\n"));
    setup.gh.answers.set("contents/src/a.ts?ref=headsha", printed("new text\n"));
    setup.gh.answers.set("repos/neoworks-dev/grove/pulls/9 --jq", pageAnswer(9, pull));
    setup.gh.answers.set("repos/neoworks-dev/grove/issues/9 --jq", pageAnswer(9, pull));
    return (await setup.github.openItem({ repo: null, number: 9, kind: "pull" }))!;
  }

  test("a file the open folder has at the pull request's head opens in the editor with the changes drawn over it", async () => {
    const setup = await setUp();
    const leafId = await pullPane(setup);
    setup.head.set(`${FOLDER}/src/a.ts`, "new text\n");
    await setup.github.openFile(leafId, setup.github.view(leafId).item.files[0]);
    expect(setup.shown).toEqual([{ path: `${FOLDER}/src/a.ts`, base: { text: "old text\n", label: "#9 base" } }]);
    expect(setup.opened).toEqual([]);
  });

  test("a file the folder has in another version opens as the two versions in a diff pane", async () => {
    const setup = await setUp();
    const leafId = await pullPane(setup);
    setup.head.set(`${FOLDER}/src/a.ts`, "something else\n");
    await setup.github.openFile(leafId, setup.github.view(leafId).item.files[0]);
    expect(setup.shown).toEqual([]);
    expect(setup.opened).toEqual([{ name: "src/a.ts", oldText: "old text\n", newText: "new text\n", label: "#9 base" }]);
  });

  test("a pull request of another repository always opens in a diff pane", async () => {
    const setup = await setUp();
    const leafId = await pullPane(setup);
    setup.head.set(`${FOLDER}/src/a.ts`, "new text\n");
    // The same page, as another repository's.
    setup.gh.answers.set("repos/other/thing/pulls/9 --jq", pageAnswer(9, { pull: true, head: { ref: "f", sha: "headsha" }, base: { ref: "main", sha: "basesha" } }));
    setup.gh.answers.set("repos/other/thing/issues/9/comments", printed(""));
    setup.gh.answers.set("repos/other/thing/pulls/9/files", printed('{"filename":"src/a.ts","status":"modified","additions":1,"deletions":1}\n'));
    setup.gh.answers.set("repos/other/thing/pulls/9/reviews", printed(""));
    setup.gh.answers.set("repos/other/thing/compare/basesha...headsha", printed("mergebase\n"));
    setup.gh.answers.set("repos/other/thing/contents/src/a.ts?ref=mergebase", printed("old text\n"));
    setup.gh.answers.set("repos/other/thing/contents/src/a.ts?ref=headsha", printed("new text\n"));
    await setup.github.openItem({ repo: "other/thing", number: 9, kind: "pull" });
    await setup.github.openFile(leafId, setup.github.view(leafId).item.files[0]);
    expect(setup.shown).toEqual([]);
    expect(setup.opened).toHaveLength(1);
  });

  test("a file the pull request added has an empty old side, and a file it removed an empty new side", async () => {
    const setup = await setUp();
    const leafId = await pullPane(setup);
    setup.gh.answers.set("contents/src/b.ts?ref=headsha", printed("brand new\n"));
    await setup.github.openFile(leafId, { path: "src/b.ts", status: "added", additions: 1, deletions: 0, previousPath: null });
    setup.gh.answers.set("contents/src/c.ts?ref=mergebase", printed("was here\n"));
    await setup.github.openFile(leafId, { path: "src/c.ts", status: "removed", additions: 0, deletions: 1, previousPath: null });
    expect(setup.opened.map((opened) => [opened.name, opened.oldText, opened.newText])).toEqual([
      ["src/b.ts", "", "brand new\n"],
      ["src/c.ts", "was here\n", ""],
    ]);
  });
});
