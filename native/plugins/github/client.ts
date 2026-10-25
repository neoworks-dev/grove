// Reads GitHub through the `gh` command line, as the person who is logged in to it. Every call is
// a `gh api` run by the Rust host (`src/gh.rs`), with `--jq` cutting each answer down to the fields
// the pane shows, so a pull request's patches never travel. The runner is a parameter so the
// client runs under `bun test` with a fake.

import {
  classifyFailure,
  failureSentence,
  parseChecks,
  parseComments,
  parseDetail,
  parseFiles,
  parseLines,
  parseObject,
  parsePull,
  parseReviews,
  parseSearch,
  type Check,
  type Comment,
  type FailureKind,
  type ItemDetail,
  type ItemKind,
  type PullDetail,
  type PullFile,
  type Review,
  type SearchResult,
} from "./model";

/** What the host answers for one run of `gh`. */
export interface GhAnswer {
  stdout: string;
  error: { kind: "missing" | "failed"; message: string; code: number | null } | null;
}

/** One call to the host. A test supplies a fake. */
export type GhRunner = (request: { args: string[]; cwd?: string }) => Promise<GhAnswer>;

/** A run of `gh` that did not succeed, with what the person can do about it. */
export class GithubError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** How many rows a list asks for; GitHub's search gives at most 100 per page. */
export const LIST_PAGE_SIZE = 50;

/** The fields a list row needs, cut out of a search result. */
const SEARCH_FIELDS =
  "{total: .total_count, items: [.items[] | {number, title, state, draft, comments, updated_at, user: .user.login, " +
  "labels: [.labels[] | {name, color}], pull: (.pull_request != null), merged: (.pull_request.merged_at != null)}]}";

/** The fields of an issue's or pull request's page that both have. */
const ITEM_FIELDS =
  "{number, title, state, draft, body, comments, created_at, updated_at, html_url, merged, additions, deletions, changed_files, " +
  "user: .user.login, assignees: [.assignees[].login], labels: [.labels[] | {name, color}], " +
  "pull: ((.pull_request != null) or (.head != null)), head: {ref: .head.ref, sha: .head.sha}, base: {ref: .base.ref, sha: .base.sha}}";

export class GithubClient {
  private authenticated = false;

  constructor(private run: GhRunner) {}

  /** Fails with why GitHub cannot be read: `gh` is missing, or no one is logged in to it. Remembers a success. */
  async checkAccess(): Promise<void> {
    if (this.authenticated) {
      return;
    }
    await this.call(["auth", "status"]);
    this.authenticated = true;
  }

  /** Forgets that a login worked, so the next call looks again. */
  forgetAccess(): void {
    this.authenticated = false;
  }

  /** The repository (`owner/name`) a folder's remote points at. */
  async resolveRepo(directory: string): Promise<string> {
    await this.checkAccess();
    const text = await this.call(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], directory);
    const repo = text.trim();
    if (repo === "") {
      throw new GithubError("noRemote", failureSentence("noRemote", ""));
    }
    return repo;
  }

  /** Issues or pull requests matching a search query, newest change first. */
  async search(query: string): Promise<SearchResult> {
    await this.checkAccess();
    const text = await this.api(
      "search/issues",
      ["-X", "GET", "-f", `q=${query}`, "-f", `per_page=${LIST_PAGE_SIZE}`, "-f", "sort=updated", "-f", "order=desc"],
      SEARCH_FIELDS,
    );
    return parseSearch(text);
  }

  /** Whether an issue number is a pull request, for a number typed without saying which. */
  async kindOf(repo: string, number: number): Promise<ItemKind> {
    const detail = await this.fetchIssue(repo, number);
    return detail.kind;
  }

  /** An issue's page, which is also what GitHub answers for a pull request's number. */
  async fetchIssue(repo: string, number: number): Promise<ItemDetail> {
    await this.checkAccess();
    const text = await this.api(`repos/${repo}/issues/${number}`, [], ITEM_FIELDS);
    return parseDetail(repo, parseObject(text));
  }

  /** A pull request's page. */
  async fetchPull(repo: string, number: number): Promise<PullDetail> {
    await this.checkAccess();
    const text = await this.api(`repos/${repo}/pulls/${number}`, [], ITEM_FIELDS);
    return parsePull(repo, parseObject(text));
  }

  /** The comments under an issue or a pull request, oldest first. */
  async fetchComments(repo: string, number: number): Promise<Comment[]> {
    const text = await this.paged(`repos/${repo}/issues/${number}/comments`, "{id, body, created_at, user: .user.login}");
    return parseComments(parseLines(text));
  }

  /** The files a pull request changes. */
  async fetchFiles(repo: string, number: number): Promise<PullFile[]> {
    const text = await this.paged(
      `repos/${repo}/pulls/${number}/files`,
      "{filename, status, additions, deletions, previous_filename}",
    );
    return parseFiles(parseLines(text));
  }

  /** The reviews a pull request has had, oldest first. */
  async fetchReviews(repo: string, number: number): Promise<Review[]> {
    const text = await this.paged(`repos/${repo}/pulls/${number}/reviews`, "{id, body, state, submitted_at, user: .user.login}");
    return parseReviews(parseLines(text));
  }

  /** The check runs and commit statuses of a commit. */
  async fetchChecks(repo: string, sha: string): Promise<Check[]> {
    await this.checkAccess();
    const runs = await this.api(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, [], ".check_runs[] | {name, status, conclusion, url: .html_url}");
    const statuses = await this.api(`repos/${repo}/commits/${sha}/status`, [], ".statuses[] | {context, state, url: .target_url}");
    return parseChecks(parseLines(runs), parseLines(statuses));
  }

  /** The commit a pull request branched from, which its diff is taken against. */
  async fetchMergeBase(repo: string, baseSha: string, headSha: string): Promise<string> {
    await this.checkAccess();
    const text = await this.api(`repos/${repo}/compare/${baseSha}...${headSha}`, [], ".merge_base_commit.sha");
    return text.trim();
  }

  /** A file's text at a commit; empty when the commit has no such file. */
  async fetchFileText(repo: string, path: string, ref: string): Promise<string> {
    await this.checkAccess();
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    try {
      return await this.call(["api", `repos/${repo}/contents/${encoded}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw+json"]);
    } catch (error) {
      if (error instanceof GithubError && error.kind === "notFound") {
        return "";
      }
      throw error;
    }
  }

  /** A `gh api` call whose answer is cut down by a `--jq` program. Parameters go in the path, since `-f` would make it a POST. */
  private api(path: string, extra: string[], program: string): Promise<string> {
    return this.call(["api", path, ...extra, "--jq", program]);
  }

  /** A list endpoint read whole by following its pages, one object per line. */
  private async paged(path: string, fields: string): Promise<string> {
    await this.checkAccess();
    return this.call(["api", `${path}?per_page=100`, "--paginate", "--jq", `.[] | ${fields}`]);
  }

  /** Runs `gh` and returns what it printed, or fails with a `GithubError`. */
  private async call(args: string[], directory?: string): Promise<string> {
    let answer: GhAnswer;
    try {
      answer = await this.run({ args, cwd: directory });
    } catch (error) {
      throw new GithubError("failed", String(error));
    }
    if (answer.error === null) {
      return answer.stdout;
    }
    const kind = classifyFailure(answer.error.kind, answer.error.message);
    if (kind === "unauthenticated") {
      this.authenticated = false;
    }
    throw new GithubError(kind, failureSentence(kind, answer.error.message));
  }
}
