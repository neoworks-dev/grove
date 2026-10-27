// The `github` service: what the GitHub panes show and how they move between a list and an item.
//
// A pane's place (which list, which filter, which item) is kept in the layout's pane state, so it
// is saved with the layout and a split of a GitHub pane starts where its source was. What was read
// from GitHub for it is kept here, in a record per pane, with a change signal; state is plain
// fields, never `$state`. Everything is read: nothing here writes to GitHub.
//
// Other plugins show an item with `ctx.github.openItem({ repo, number, kind })`.

import { Service, type Context } from "@neoworks/extension-system";
import type { RepoInfo, Worktree } from "../../../src/shared/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import { GithubClient, GithubError } from "./client";
import {
  searchQuery,
  type Check,
  type Comment,
  type FailureKind,
  type ItemDetail,
  type ItemKind,
  type ItemSummary,
  type ListFilter,
  type PullDetail,
  type PullFile,
  type Review,
} from "./model";

declare module "@neoworks/extension-system" {
  interface Context {
    github: GithubService;
  }
}

/** The pane type of the GitHub pane, the key of its entry in the `main` slot. */
export const GITHUB_PANE_TYPE = "github";

/** The key a GitHub pane keeps its place under in the layout's pane state. */
const STATE_KEY = "github";

/** Where a GitHub pane is: a list, or one item. */
export interface GithubPlace {
  /** `owner/name` the pane reads, or null for the open folder's own repository. */
  repo: string | null;
  view: "list" | "item";
  /** Which list the pane shows, and which one `back` returns to. */
  listKind: ItemKind;
  filter: ListFilter;
  /** The text the list was searched for. */
  search: string;
  /** The item shown when `view` is "item". */
  item: { kind: ItemKind; number: number } | null;
}

/** A load that is under way, done, or failed. */
export type LoadStatus = "loading" | "ready" | "error";

/** What a list holds. */
export interface ListLoad {
  status: LoadStatus;
  items: ItemSummary[];
  /** How many items matched in all, which may be more than are listed. */
  total: number;
  message: string;
}

/** What an item's page holds; the parts after `detail` are read once the head of the page is up. */
export interface ItemLoad {
  status: LoadStatus;
  message: string;
  detail: ItemDetail | PullDetail | null;
  /** Whether the comments, files, reviews and checks have been read. */
  extras: LoadStatus;
  extrasMessage: string;
  comments: Comment[];
  files: PullFile[];
  reviews: Review[];
  checks: Check[];
}

/** Why GitHub cannot be read at all, which the pane shows in place of its content. */
export interface Failure {
  kind: FailureKind;
  message: string;
}

/** Everything a pane's view draws. */
export interface GithubView {
  place: GithubPlace;
  /** The repository being read, once known. */
  repo: string | null;
  /** Set while nothing can be shown: `gh` missing, not logged in, no remote. */
  failure: Failure | null;
  list: ListLoad;
  item: ItemLoad;
}

/** What the service needs to know about the open folder. */
export interface GithubWorkspace {
  selectedWorktree(): Worktree | null;
  repo(): RepoInfo | null;
  onSelectionChange(listener: (worktree: Worktree | null) => void): () => void;
}

/** What the service needs from the layout. */
export interface GithubLayout {
  readonly focusedLeafId: string;
  leafIds(): string[];
  paneTypeOf(leafId: string): string | undefined;
  paneState(leafId: string): Record<string, unknown>;
  setPaneState(leafId: string, patch: Record<string, unknown>): void;
  splitFocused(direction: "row" | "column", paneTypeId?: string): void;
  focus(leafId: string): void;
  onPaneClosed(listener: (leafId: string) => void): () => void;
}

/** What the service needs to show a pull request's file. */
export interface GithubDiffs {
  /** Shows how a file differs from a text, drawn over the file in an editor. */
  showInEditor(path: string, base: { text: string; label: string }): Promise<boolean>;
  /** Shows how two texts differ in a diff tab. */
  openTexts(name: string, oldText: string, newText: string, label: string): Promise<string | null>;
  /** A file as HEAD has it in the checked out repository. */
  headText(path: string): Promise<{ exists: boolean; text: string }>;
}

/** What the service asks of the app beyond its own plugins. */
export interface GithubDeps {
  client: GithubClient;
  workspace: GithubWorkspace;
  layout: GithubLayout;
  diffs: GithubDiffs;
  /** Opens an address in the system's browser. */
  openUrl(url: string): void;
}

/** A pane's loads, and the counters that tell a load that was overtaken. */
interface PaneRecord {
  list: ListLoad;
  item: ItemLoad;
  listGeneration: number;
  itemGeneration: number;
  /** The repository the pane resolved for its place, when it reads the open folder's. */
  repo: string | null;
  failure: Failure | null;
}

/** A list that has not been read. */
function emptyList(): ListLoad {
  return { status: "loading", items: [], total: 0, message: "" };
}

/** An item that has not been read. */
function emptyItem(): ItemLoad {
  return {
    status: "loading",
    message: "",
    detail: null,
    extras: "loading",
    extrasMessage: "",
    comments: [],
    files: [],
    reviews: [],
    checks: [],
  };
}

/** The place a new pane starts at: open issues. */
export function initialPlace(repo: string | null): GithubPlace {
  return { repo, view: "list", listKind: "issue", filter: { state: "open", mine: false }, search: "", item: null };
}

/** The sentence for an error that is not a `GithubError`. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class GithubService extends Service {
  private records = new Map<string, PaneRecord>();
  private changes: ChangeSignal = createChangeSignal();
  /** The panes whose search box was asked to take the keyboard and has not yet. */
  private focusPending = new Set<string>();
  /** The repository of the open folder, once `gh` has said which it is. */
  private folderRepo: { directory: string; repo: string } | null = null;
  private resolving: Promise<string> | null = null;

  constructor(
    ctx: Context,
    private deps: GithubDeps,
  ) {
    super(ctx, "github");
    ctx.effect(() => deps.layout.onPaneClosed((leafId) => this.forget(leafId)), "github.paneClosed");
    ctx.effect(
      () =>
        deps.workspace.onSelectionChange(() => {
          this.folderRepo = null;
        }),
      "github.selection",
    );
  }

  /** What a pane draws. Reactive. */
  view(leafId: string): GithubView {
    this.changes.track();
    const place = this.placeOf(leafId);
    const record = this.recordOf(leafId);
    return { place, repo: this.repoOf(place, record), failure: record.failure, list: record.list, item: record.item };
  }

  /** The title of a GitHub pane. Reactive. */
  paneTitle(leafId: string): string {
    this.changes.track();
    const place = this.placeOf(leafId);
    if (place.view === "item" && place.item !== null) {
      return `#${place.item.number}`;
    }
    if (place.listKind === "pull") {
      return "Pull requests";
    }
    return "Issues";
  }

  /** Whether a pane's search box was asked to take the keyboard and has not yet. Reactive. */
  focusRequested(leafId: string): boolean {
    this.changes.track();
    return this.focusPending.has(leafId);
  }

  /** The pane's search box has taken the keyboard, so the request is done. */
  focusServed(leafId: string): void {
    this.focusPending.delete(leafId);
    this.changes.notify();
  }

  /** Shows a list in a GitHub pane, opening one when there is none. */
  async openList(kind: ItemKind): Promise<string | null> {
    const leafId = this.paneFor();
    if (leafId === null) {
      return null;
    }
    this.place(leafId, { ...this.placeOf(leafId), view: "list", listKind: kind, item: null });
    this.deps.layout.focus(leafId);
    await this.loadList(leafId);
    return leafId;
  }

  /**
   * Shows an issue or a pull request in a GitHub pane. `repo` is `owner/name`, or null for the
   * open folder's own; `kind` null looks up whether the number is an issue or a pull request.
   * Resolves to the pane, or null when none could be made.
   */
  async openItem(request: { repo: string | null; number: number; kind: ItemKind | null }): Promise<string | null> {
    const leafId = this.paneFor();
    if (leafId === null) {
      return null;
    }
    this.deps.layout.focus(leafId);
    await this.showReference(leafId, request);
    return leafId;
  }

  /** Shows an issue or a pull request in a given GitHub pane, as `openItem` describes. */
  async showReference(leafId: string, request: { repo: string | null; number: number; kind: ItemKind | null }): Promise<void> {
    let kind: ItemKind = "issue";
    if (request.kind !== null) {
      kind = request.kind;
    }
    this.place(leafId, { ...this.placeOf(leafId), repo: request.repo, view: "item", item: { kind, number: request.number } });
    await this.loadItem(leafId, request.kind === null);
  }

  /** Makes the search box of the focused GitHub pane (a new one when there is none) take the keyboard. */
  async focusSearch(): Promise<void> {
    const leafId = this.paneFor();
    if (leafId === null) {
      return;
    }
    this.deps.layout.focus(leafId);
    // The box is only in the list's toolbar, so a pane on an item goes back to its list.
    if (this.placeOf(leafId).view === "item") {
      this.place(leafId, { ...this.placeOf(leafId), view: "list", item: null });
    }
    this.focusPending.add(leafId);
    this.changes.notify();
    await this.ensureLoaded(leafId);
  }

  /** Reads what a pane shows if it has not, such as a pane restored with the layout. */
  async ensureLoaded(leafId: string): Promise<void> {
    const record = this.recordOf(leafId);
    const place = this.placeOf(leafId);
    if (place.view === "item" && record.itemGeneration === 0) {
      await this.loadItem(leafId, false);
      return;
    }
    if (place.view === "list" && record.listGeneration === 0) {
      await this.loadList(leafId);
    }
  }

  /** Changes which list a pane shows. */
  async setListKind(leafId: string, kind: ItemKind): Promise<void> {
    this.place(leafId, { ...this.placeOf(leafId), view: "list", listKind: kind, item: null });
    await this.loadList(leafId);
  }

  /** Changes a pane's filters and reads the list again. */
  async setFilter(leafId: string, filter: ListFilter): Promise<void> {
    this.place(leafId, { ...this.placeOf(leafId), filter });
    await this.loadList(leafId);
  }

  /** Searches a pane's list for text, with GitHub's own search syntax. */
  async setSearch(leafId: string, search: string): Promise<void> {
    this.place(leafId, { ...this.placeOf(leafId), search });
    await this.loadList(leafId);
  }

  /** Shows an item of the pane's list. */
  async showItem(leafId: string, summary: ItemSummary): Promise<void> {
    const current = this.placeOf(leafId);
    this.place(leafId, { ...current, view: "item", item: { kind: summary.kind, number: summary.number } });
    await this.loadItem(leafId, false);
  }

  /** Goes from an item back to the list it was opened from. */
  async back(leafId: string): Promise<void> {
    const current = this.placeOf(leafId);
    this.place(leafId, { ...current, view: "list", item: null });
    const record = this.recordOf(leafId);
    if (record.listGeneration === 0) {
      await this.loadList(leafId);
    }
    this.changes.notify();
  }

  /** Reads what the pane shows again, such as after logging in. */
  async reload(leafId: string): Promise<void> {
    this.deps.client.forgetAccess();
    this.folderRepo = null;
    const place = this.placeOf(leafId);
    if (place.view === "item" && place.item !== null) {
      await this.loadItem(leafId, false);
      return;
    }
    await this.loadList(leafId);
  }

  /** Opens the shown item's page in the browser. */
  openInBrowser(leafId: string): void {
    const detail = this.recordOf(leafId).item.detail;
    if (detail !== null && detail.url !== "") {
      this.deps.openUrl(detail.url);
    }
  }

  /**
   * Shows one file of the pull request a pane shows. When the open folder has that repository at
   * the pull request's head, the file's diff tab shows its changes;
   * otherwise a diff tab shows the two versions, since the file here is not the pull request's.
   */
  async openFile(leafId: string, file: PullFile): Promise<void> {
    const record = this.recordOf(leafId);
    const detail = record.item.detail;
    if (detail === null || detail.kind !== "pull") {
      return;
    }
    const pull = detail as PullDetail;
    try {
      await this.showPullFile(pull, file);
    } catch (error) {
      record.item.extrasMessage = describe(error);
      this.changes.notify();
    }
  }

  /** The place a pane is at, from its pane state. */
  private placeOf(leafId: string): GithubPlace {
    const stored = this.deps.layout.paneState(leafId)[STATE_KEY];
    if (typeof stored === "object" && stored !== null) {
      return { ...initialPlace(null), ...(stored as Partial<GithubPlace>) };
    }
    return initialPlace(null);
  }

  /** Records where a pane is. */
  private place(leafId: string, place: GithubPlace): void {
    this.deps.layout.setPaneState(leafId, { [STATE_KEY]: place });
    this.changes.notify();
  }

  /** The record of a pane, made when it has none. */
  private recordOf(leafId: string): PaneRecord {
    const known = this.records.get(leafId);
    if (known !== undefined) {
      return known;
    }
    const made: PaneRecord = {
      list: emptyList(),
      item: emptyItem(),
      listGeneration: 0,
      itemGeneration: 0,
      repo: null,
      failure: null,
    };
    this.records.set(leafId, made);
    return made;
  }

  /** Drops what a closed pane held. */
  private forget(leafId: string): void {
    this.records.delete(leafId);
  }

  /** The repository a place reads: its own, else the one resolved for the open folder. */
  private repoOf(place: GithubPlace, record: PaneRecord): string | null {
    if (place.repo !== null) {
      return place.repo;
    }
    return record.repo;
  }

  /** The pane GitHub things go to: the focused GitHub pane, else the first, else a new one split off the focused pane. */
  private paneFor(): string | null {
    const layout = this.deps.layout;
    const ids = layout.leafIds().filter((leafId) => layout.paneTypeOf(leafId) === GITHUB_PANE_TYPE);
    if (ids.includes(layout.focusedLeafId)) {
      return layout.focusedLeafId;
    }
    if (ids.length > 0) {
      return ids[0];
    }
    layout.splitFocused("row", GITHUB_PANE_TYPE);
    const created = layout.focusedLeafId;
    if (layout.paneTypeOf(created) !== GITHUB_PANE_TYPE) {
      return null;
    }
    return created;
  }

  /** The repository of the open folder, asked of `gh` once per folder. */
  private async folderRepository(): Promise<string> {
    const worktree = this.deps.workspace.selectedWorktree();
    const repoInfo = this.deps.workspace.repo();
    let directory = "";
    if (worktree !== null) {
      directory = worktree.path;
    } else if (repoInfo !== null) {
      directory = repoInfo.path;
    }
    if (directory === "") {
      throw new GithubError("noRemote", "Open a folder to see its issues and pull requests.");
    }
    if (this.folderRepo !== null && this.folderRepo.directory === directory) {
      return this.folderRepo.repo;
    }
    if (this.resolving === null) {
      this.resolving = this.deps.client.resolveRepo(directory).finally(() => {
        this.resolving = null;
      });
    }
    const repo = await this.resolving;
    this.folderRepo = { directory, repo };
    return repo;
  }

  /** The repository a pane reads, resolved into its record, or the failure that stops it. */
  private async resolveRepo(leafId: string): Promise<string | null> {
    const record = this.recordOf(leafId);
    const place = this.placeOf(leafId);
    try {
      if (place.repo !== null) {
        await this.deps.client.checkAccess();
        record.failure = null;
        return place.repo;
      }
      const repo = await this.folderRepository();
      record.repo = repo;
      record.failure = null;
      return repo;
    } catch (error) {
      record.failure = this.failureOf(error);
      this.changes.notify();
      return null;
    }
  }

  /** A failure as the pane shows it. */
  private failureOf(error: unknown): Failure {
    if (error instanceof GithubError) {
      return { kind: error.kind, message: error.message };
    }
    return { kind: "failed", message: describe(error) };
  }

  /** Reads the list a pane's place asks for. A newer read replaces one still under way. */
  private async loadList(leafId: string): Promise<void> {
    const record = this.recordOf(leafId);
    record.listGeneration += 1;
    const generation = record.listGeneration;
    record.list = { ...record.list, status: "loading", message: "" };
    this.changes.notify();
    const repo = await this.resolveRepo(leafId);
    if (repo === null || generation !== record.listGeneration) {
      return;
    }
    const place = this.placeOf(leafId);
    try {
      const result = await this.deps.client.search(searchQuery(repo, place.listKind, place.filter, place.search));
      if (generation !== record.listGeneration) {
        return;
      }
      record.list = { status: "ready", items: result.items, total: result.total, message: "" };
    } catch (error) {
      if (generation !== record.listGeneration) {
        return;
      }
      record.list = { status: "error", items: [], total: 0, message: this.failureOf(error).message };
    }
    this.changes.notify();
  }

  /** Reads the item a pane's place names, the head of its page first and the rest after. */
  private async loadItem(leafId: string, kindUnknown: boolean): Promise<void> {
    const record = this.recordOf(leafId);
    record.itemGeneration += 1;
    const generation = record.itemGeneration;
    record.item = emptyItem();
    this.changes.notify();
    const repo = await this.resolveRepo(leafId);
    const target = this.placeOf(leafId).item;
    if (repo === null || target === null || generation !== record.itemGeneration) {
      return;
    }
    try {
      const detail = await this.fetchDetail(repo, target.kind, target.number, kindUnknown);
      if (generation !== record.itemGeneration) {
        return;
      }
      this.place(leafId, { ...this.placeOf(leafId), item: { kind: detail.kind, number: detail.number } });
      record.item = { ...emptyItem(), status: "ready", detail };
      this.changes.notify();
      await this.loadExtras(leafId, generation, detail);
    } catch (error) {
      if (generation !== record.itemGeneration) {
        return;
      }
      record.item = { ...emptyItem(), status: "error", message: this.failureOf(error).message };
      this.changes.notify();
    }
  }

  /** The head of an item's page; a number of unknown kind is looked up as an issue first, which says if it is a pull request. */
  private async fetchDetail(repo: string, kind: ItemKind, number: number, kindUnknown: boolean): Promise<ItemDetail | PullDetail> {
    let resolvedKind = kind;
    if (kindUnknown) {
      resolvedKind = await this.deps.client.kindOf(repo, number);
    }
    if (resolvedKind === "pull") {
      return this.deps.client.fetchPull(repo, number);
    }
    return this.deps.client.fetchIssue(repo, number);
  }

  /** Reads the comments of an item and, for a pull request, its files, reviews and checks. */
  private async loadExtras(leafId: string, generation: number, detail: ItemDetail | PullDetail): Promise<void> {
    const record = this.recordOf(leafId);
    const client = this.deps.client;
    const isPull = detail.kind === "pull";
    const pull = detail as PullDetail;
    const [comments, files, reviews, checks] = await Promise.allSettled([
      client.fetchComments(detail.repo, detail.number),
      this.whenPull(isPull, () => client.fetchFiles(detail.repo, detail.number)),
      this.whenPull(isPull, () => client.fetchReviews(detail.repo, detail.number)),
      this.whenPull(isPull, () => client.fetchChecks(detail.repo, pull.headSha)),
    ]);
    if (generation !== record.itemGeneration) {
      return;
    }
    const failed = [comments, files, reviews, checks].find((outcome) => outcome.status === "rejected");
    const item = record.item;
    item.comments = this.settled(comments, []);
    item.files = this.settled(files, []);
    item.reviews = this.settled(reviews, []);
    item.checks = this.settled(checks, []);
    item.extras = "ready";
    if (failed !== undefined && failed.status === "rejected") {
      item.extras = "error";
      item.extrasMessage = this.failureOf(failed.reason).message;
    }
    this.changes.notify();
  }

  /** Runs a read only for a pull request; an issue has nothing to read and gets an empty list. */
  private async whenPull<Value>(isPull: boolean, read: () => Promise<Value[]>): Promise<Value[]> {
    if (!isPull) {
      return [];
    }
    return read();
  }

  /** What a settled read gave, or the fallback when it failed. */
  private settled<Value>(outcome: PromiseSettledResult<Value>, fallback: Value): Value {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    return fallback;
  }

  /** Opens one file of a pull request, as `openFile` describes. */
  private async showPullFile(pull: PullDetail, file: PullFile): Promise<void> {
    const client = this.deps.client;
    const base = await client.fetchMergeBase(pull.repo, pull.baseSha, pull.headSha);
    let oldText = "";
    if (file.status !== "added") {
      oldText = await client.fetchFileText(pull.repo, this.oldPathOf(file), base);
    }
    let newText = "";
    if (file.status !== "removed") {
      newText = await client.fetchFileText(pull.repo, file.path, pull.headSha);
    }
    const label = `#${pull.number} base`;
    if (await this.isCheckedOut(pull, file, newText)) {
      const path = `${this.folderPath()}/${file.path}`;
      if (await this.deps.diffs.showInEditor(path, { text: oldText, label })) {
        return;
      }
    }
    await this.deps.diffs.openTexts(file.path, oldText, newText, label);
  }

  /** The path a file had before the pull request. */
  private oldPathOf(file: PullFile): string {
    if (file.previousPath !== null) {
      return file.previousPath;
    }
    return file.path;
  }

  /** The directory of the open folder's worktree, or an empty string. */
  private folderPath(): string {
    const worktree = this.deps.workspace.selectedWorktree();
    if (worktree !== null) {
      return worktree.path;
    }
    const repoInfo = this.deps.workspace.repo();
    if (repoInfo !== null) {
      return repoInfo.path;
    }
    return "";
  }

  /** Whether the open folder is this pull request's repository with the file as the pull request's head has it. */
  private async isCheckedOut(pull: PullDetail, file: PullFile, newText: string): Promise<boolean> {
    if (file.status === "removed") {
      return false;
    }
    let folder: string;
    try {
      folder = await this.folderRepository();
    } catch {
      return false;
    }
    if (folder !== pull.repo) {
      return false;
    }
    const here = await this.deps.diffs.headText(`${this.folderPath()}/${file.path}`);
    return here.exists && here.text === newText;
  }
}
