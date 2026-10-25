// What the GitHub pane knows about issues and pull requests: the types it shows, the parsing of
// what `gh api` prints into them, the search query a list is asked with and the reading of an
// item typed by number. No host and no Svelte, so it runs under `bun test`.

/** An issue or a pull request. */
export type ItemKind = "issue" | "pull";

/** What an item's tag says. A pull request is `merged` or `draft` where an issue is only open or closed. */
export type ItemState = "open" | "closed" | "merged" | "draft";

/** A label as GitHub colours it; `color` is six hex digits without the hash. */
export interface Label {
  name: string;
  color: string;
}

/** One row of a list. */
export interface ItemSummary {
  kind: ItemKind;
  number: number;
  title: string;
  state: ItemState;
  author: string;
  labels: Label[];
  comments: number;
  /** When the item last changed, as an ISO time. */
  updatedAt: string;
}

/** Everything an issue and a pull request share on their own page. */
export interface ItemDetail extends ItemSummary {
  repo: string;
  body: string;
  assignees: string[];
  createdAt: string;
  url: string;
}

/** A comment on an issue or a pull request. */
export interface Comment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

/** How one check of a pull request stands. */
export type CheckState = "passing" | "failing" | "pending" | "skipped";

/** One check run or commit status of a pull request's head. */
export interface Check {
  name: string;
  state: CheckState;
  url: string;
}

/** What a review decided. */
export type ReviewState = "approved" | "changes requested" | "commented" | "dismissed" | "pending";

/** One submitted review. */
export interface Review {
  id: number;
  author: string;
  state: ReviewState;
  body: string;
  submittedAt: string;
}

/** How a pull request changed a file. */
export type FileStatus = "added" | "modified" | "removed" | "renamed";

/** One file a pull request changes. */
export interface PullFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** The path before a rename. */
  previousPath: string | null;
}

/** A pull request's page: the item and what only a pull request has. */
export interface PullDetail extends ItemDetail {
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  merged: boolean;
}

/** The three filters of a list: open or closed, and only what the person wrote. */
export interface ListFilter {
  state: "open" | "closed";
  mine: boolean;
}

/** A line of `gh api --jq` output as a value of unknown shape. */
type Json = Record<string, unknown>;

/** The text of a field, empty when it is missing or not text. */
function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return "";
}

/** The number in a field, zero when it is missing or not a number. */
function numberOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

/** The object in a field, empty when it is missing or not an object. */
function objectOf(value: unknown): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Json;
  }
  return {};
}

/** The list in a field, empty when it is missing or not a list. */
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

/** Parses JSON that must be an object, or fails with the words of the problem. */
export function parseObject(text: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GitHub answered with something that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GitHub answered with something unexpected");
  }
  return parsed as Json;
}

/** Parses output with one JSON object per line, as `gh api --paginate --jq '.[] | {…}'` prints it. */
export function parseLines(text: string): Json[] {
  const objects: Json[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    objects.push(parseObject(line));
  }
  return objects;
}

/** The labels of an item. */
function labelsOf(value: unknown): Label[] {
  return listOf(value).map((entry) => {
    const label = entry as Json;
    return { name: textOf(label["name"]), color: textOf(label["color"]) };
  });
}

/** The state of an item from the fields GitHub gives for it. */
export function stateOf(kind: ItemKind, state: string, draft: boolean, merged: boolean): ItemState {
  if (merged) {
    return "merged";
  }
  if (state === "closed") {
    return "closed";
  }
  if (kind === "pull" && draft) {
    return "draft";
  }
  return "open";
}

/** One row of a list from the object the search printed for it. */
export function parseSummary(entry: Json): ItemSummary {
  let kind: ItemKind = "issue";
  if (entry["pull"] === true) {
    kind = "pull";
  }
  return {
    kind,
    number: numberOf(entry["number"]),
    title: textOf(entry["title"]),
    state: stateOf(kind, textOf(entry["state"]), entry["draft"] === true, entry["merged"] === true),
    author: textOf(entry["user"]),
    labels: labelsOf(entry["labels"]),
    comments: numberOf(entry["comments"]),
    updatedAt: textOf(entry["updated_at"]),
  };
}

/** What a search answers: the rows and how many items matched in all. */
export interface SearchResult {
  total: number;
  items: ItemSummary[];
}

/** Reads the answer of a search. */
export function parseSearch(text: string): SearchResult {
  const answer = parseObject(text);
  return { total: numberOf(answer["total"]), items: listOf(answer["items"]).map((entry) => parseSummary(entry as Json)) };
}

/** The part of an item's page that issues and pull requests share, read from the object printed for it. */
export function parseDetail(repo: string, entry: Json): ItemDetail {
  const summary = parseSummary(entry);
  return {
    ...summary,
    repo,
    body: textOf(entry["body"]),
    assignees: listOf(entry["assignees"]).map((assignee) => textOf(assignee)),
    createdAt: textOf(entry["created_at"]),
    url: textOf(entry["html_url"]),
  };
}

/** A pull request's page from the object printed for it. */
export function parsePull(repo: string, entry: Json): PullDetail {
  const detail = parseDetail(repo, { ...entry, pull: true });
  const head = objectOf(entry["head"]);
  const base = objectOf(entry["base"]);
  return {
    ...detail,
    headBranch: textOf(head["ref"]),
    headSha: textOf(head["sha"]),
    baseBranch: textOf(base["ref"]),
    baseSha: textOf(base["sha"]),
    additions: numberOf(entry["additions"]),
    deletions: numberOf(entry["deletions"]),
    changedFiles: numberOf(entry["changed_files"]),
    merged: entry["merged"] === true,
  };
}

/** Comments from the objects printed for them. */
export function parseComments(entries: Json[]): Comment[] {
  return entries.map((entry) => ({
    id: numberOf(entry["id"]),
    author: textOf(entry["user"]),
    body: textOf(entry["body"]),
    createdAt: textOf(entry["created_at"]),
  }));
}

/** A review's state in words. */
function reviewStateOf(state: string): ReviewState {
  if (state === "APPROVED") {
    return "approved";
  }
  if (state === "CHANGES_REQUESTED") {
    return "changes requested";
  }
  if (state === "DISMISSED") {
    return "dismissed";
  }
  if (state === "PENDING") {
    return "pending";
  }
  return "commented";
}

/** Reviews from the objects printed for them, oldest first. */
export function parseReviews(entries: Json[]): Review[] {
  return entries.map((entry) => ({
    id: numberOf(entry["id"]),
    author: textOf(entry["user"]),
    state: reviewStateOf(textOf(entry["state"])),
    body: textOf(entry["body"]),
    submittedAt: textOf(entry["submitted_at"]),
  }));
}

/** How a finished or running check run stands. */
function checkRunState(status: string, conclusion: string): CheckState {
  if (status !== "completed") {
    return "pending";
  }
  if (conclusion === "success") {
    return "passing";
  }
  if (conclusion === "skipped" || conclusion === "neutral" || conclusion === "cancelled") {
    return "skipped";
  }
  return "failing";
}

/** How a commit status stands. */
function commitStatusState(state: string): CheckState {
  if (state === "success") {
    return "passing";
  }
  if (state === "pending") {
    return "pending";
  }
  return "failing";
}

/** Checks from the objects printed for check runs and for commit statuses. */
export function parseChecks(runs: Json[], statuses: Json[]): Check[] {
  const checks: Check[] = runs.map((run) => ({
    name: textOf(run["name"]),
    state: checkRunState(textOf(run["status"]), textOf(run["conclusion"])),
    url: textOf(run["url"]),
  }));
  for (const status of statuses) {
    checks.push({ name: textOf(status["context"]), state: commitStatusState(textOf(status["state"])), url: textOf(status["url"]) });
  }
  return checks;
}

/** What the checks add up to: failing if any failed, else pending if any runs, else passing; null when there are none. */
export function checksSummary(checks: Check[]): CheckState | null {
  if (checks.length === 0) {
    return null;
  }
  if (checks.some((check) => check.state === "failing")) {
    return "failing";
  }
  if (checks.some((check) => check.state === "pending")) {
    return "pending";
  }
  if (checks.every((check) => check.state === "skipped")) {
    return "skipped";
  }
  return "passing";
}

/** A file's change from GitHub's word for it. */
function fileStatusOf(status: string): FileStatus {
  if (status === "added") {
    return "added";
  }
  if (status === "removed") {
    return "removed";
  }
  if (status === "renamed") {
    return "renamed";
  }
  return "modified";
}

/** Changed files from the objects printed for them. */
export function parseFiles(entries: Json[]): PullFile[] {
  return entries.map((entry) => {
    let previousPath: string | null = null;
    if (typeof entry["previous_filename"] === "string") {
      previousPath = entry["previous_filename"];
    }
    return {
      path: textOf(entry["filename"]),
      status: fileStatusOf(textOf(entry["status"])),
      additions: numberOf(entry["additions"]),
      deletions: numberOf(entry["deletions"]),
      previousPath,
    };
  });
}

/** The search qualifiers that make a list: the repository, the kind, the state and whose items. */
export function searchQuery(repo: string, kind: ItemKind, filter: ListFilter, text: string): string {
  const parts = [`repo:${repo}`];
  if (kind === "issue") {
    parts.push("is:issue");
  } else {
    parts.push("is:pr");
  }
  parts.push(`is:${filter.state}`);
  if (filter.mine) {
    parts.push("author:@me");
  }
  const typed = text.trim();
  if (typed !== "") {
    parts.push(typed);
  }
  return parts.join(" ");
}

/** An item named by a person or an agent: where it is, which one, and its kind when the words say. */
export interface ItemReference {
  /** `owner/name`, or null when the words name only a number. */
  repo: string | null;
  number: number;
  kind: ItemKind | null;
}

/**
 * Reads an item from what was typed: `12`, `#12`, `owner/name#12`, or the address of its page on
 * GitHub, which also says whether it is an issue or a pull request. Null when it names none.
 */
export function parseReference(text: string): ItemReference | null {
  const typed = text.trim();
  const address = typed.match(/^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)/);
  if (address !== null) {
    let kind: ItemKind = "issue";
    if (address[2] === "pull") {
      kind = "pull";
    }
    return { repo: address[1], number: Number(address[3]), kind };
  }
  const qualified = typed.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (qualified !== null) {
    return { repo: qualified[1], number: Number(qualified[2]), kind: null };
  }
  const bare = typed.match(/^#?(\d+)$/);
  if (bare !== null) {
    return { repo: null, number: Number(bare[1]), kind: null };
  }
  return null;
}

/** The last words of a failed run of `gh`, grouped by what the person can do about them. */
export type FailureKind = "missing" | "unauthenticated" | "noRemote" | "notFound" | "rateLimited" | "failed";

/** What `gh` failure's words mean, from the host's kind and `gh`'s own message. */
export function classifyFailure(hostKind: string, message: string): FailureKind {
  if (hostKind === "missing") {
    return "missing";
  }
  const lower = message.toLowerCase();
  if (lower.includes("gh auth login") || lower.includes("not logged in") || lower.includes("bad credentials") || lower.includes("http 401")) {
    return "unauthenticated";
  }
  if (lower.includes("no git remotes found") || lower.includes("none of the git remotes")) {
    return "noRemote";
  }
  if (lower.includes("rate limit")) {
    return "rateLimited";
  }
  if (lower.includes("http 404") || lower.includes("not found")) {
    return "notFound";
  }
  return "failed";
}

/** The sentence the pane shows for a failure. */
export function failureSentence(kind: FailureKind, message: string): string {
  if (kind === "missing") {
    return "The GitHub CLI (gh) is not installed. Install it from cli.github.com, then run gh auth login.";
  }
  if (kind === "unauthenticated") {
    return "You are not logged in to GitHub. Run gh auth login in a terminal, then reload.";
  }
  if (kind === "noRemote") {
    return "This folder has no remote on GitHub, so there are no issues or pull requests to show.";
  }
  if (kind === "rateLimited") {
    return "GitHub is limiting requests for now. Try again in a minute.";
  }
  if (kind === "notFound") {
    return "GitHub has nothing at that address, or your login cannot see it.";
  }
  return message;
}
