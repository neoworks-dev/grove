// The `lsp` service: which language servers the host runs and how they are doing, for the status
// bar. Everything else about language servers (diagnostics, completion, hover) happens in the
// host and in the editor element, so this is only what the person is told and can press.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { LspHost } from "./host";
import { statusEntries, type ServerSummary, type StatusEntry } from "./servers";

declare module "@neoworks/extension-system" {
  interface Context {
    lsp: LspService;
  }
}

export class LspService extends Service {
  private current: ServerSummary[] = [];
  private changes: ChangeSignal = createChangeSignal();

  constructor(
    ctx: Context,
    private host: LspHost,
  ) {
    super(ctx, "lsp");
    ctx.effect(() => host.onStatus((servers) => this.replace(servers)), "lsp.status");
    void host.status().then((servers) => this.replace(servers), () => {});
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
