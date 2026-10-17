// The `lsp` service: which language servers the host runs and how they are doing, for the status
// bar. Everything else about language servers (diagnostics, completion, hover) happens in the
// host and in the editor element, so this is only what the person is told and can press.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { FileChange, LspHost, LspOptions } from "./host";
import { statusEntries, type ServerSummary, type StatusEntry } from "./servers";

declare module "@neoworks/extension-system" {
  interface Context {
    lsp: LspService;
  }
}

/** How long file changes are gathered before the servers hear of them. */
const FILE_CHANGE_DELAY_MS = 100;

/** What the sidecar's watcher says about one path (see `explorer/model.ts`). */
export interface WatchedChange {
  relPath: string;
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
}

export class LspService extends Service {
  private pendingChanges: FileChange[] = [];
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private current: ServerSummary[] = [];
  private changes: ChangeSignal = createChangeSignal();

  constructor(
    ctx: Context,
    private host: LspHost,
  ) {
    super(ctx, "lsp");
    ctx.effect(() => host.onStatus((servers) => this.replace(servers)), "lsp.status");
    void host.status().then((servers) => this.replace(servers), () => {});
    ctx.effect(() => () => clearTimeout(this.changeTimer), "lsp.fileChanges");
  }

  /** Tells the host which language features are switched on. */
  async configure(options: LspOptions): Promise<void> {
    await this.host.configure(options);
  }

  /**
   * Passes on what the file watcher saw in the worktree at `root`, a moment after the last
   * change so a burst of them is one message. Directories are not files, so they are left out.
   */
  noteWatchedChange(root: string, change: WatchedChange): void {
    const kind = { add: "created", change: "changed", unlink: "deleted" }[change.type as string] as
      | FileChange["kind"]
      | undefined;
    if (kind === undefined) {
      return;
    }
    this.pendingChanges.push({ path: `${root}/${change.relPath}`, kind });
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.flushChanges(), FILE_CHANGE_DELAY_MS);
  }

  /** Sends the gathered file changes to the host. */
  private flushChanges(): void {
    const changes = this.pendingChanges;
    this.pendingChanges = [];
    if (changes.length === 0) {
      return;
    }
    this.host.filesChanged(changes).catch(() => {});
  }

  /** The servers the host runs, in the order they started. Reactive. */
  servers(): ServerSummary[] {
    this.changes.track();
    return this.current;
  }

  /** The servers as status bar entries. Reactive. */
  entries(): StatusEntry[] {
    return statusEntries(this.servers());
  }

  /** Starts a server that is not running again. */
  async restart(id: number): Promise<void> {
    await this.host.restart(id);
  }

  /** Takes the host's list as the truth, and tells readers. */
  private replace(servers: ServerSummary[]): void {
    this.current = servers;
    this.changes.notify();
  }
}
