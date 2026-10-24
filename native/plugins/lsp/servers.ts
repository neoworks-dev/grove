// What the host says about language servers (`src/lsp/mod.rs`), and how the status bar words it.
// Plain functions so they run under `bun test`.

/** How a server is doing. */
export type ServerStateName = "starting" | "ready" | "failed" | "exited" | "stopped" | "missing";

/** A language server as the host describes it. */
export interface ServerSummary {
  id: number;
  name: string;
  root: string;
  state: ServerStateName;
  /** Why it failed or ended, or what to install when it is missing. */
  message: string;
  /** What it says it is busy with, such as "Indexing 3/10". */
  busy: string | null;
  /** The tool that installs it, for a server that is missing and that Grove has a recipe for. */
  tool?: string | null;
}

/** How installing a tool is going, which the status bar shows in place of the server that waits for it. */
export interface ToolInstall {
  state: "installing" | "failed";
  /** The step it is on, or why it failed. */
  message: string;
}

/** Which colour name the status dot of a server is drawn in. */
export type StatusTone = "good" | "busy" | "bad" | "quiet";

/** One server as one entry of the status bar. */
export interface StatusEntry {
  id: number;
  text: string;
  tone: StatusTone;
  /** Whether pressing it does something: starting a server that is down, or installing one that is missing. */
  restartable: boolean;
  /** What pressing it does, if anything. */
  action: "restart" | "install" | null;
  /** The longer explanation, for a place to show it. */
  detail: string;
}

/** The status bar's entries for the servers, in the order they started. `installs` is how installing each tool is going. */
export function statusEntries(servers: ServerSummary[], installs: ReadonlyMap<string, ToolInstall> = new Map()): StatusEntry[] {
  return servers.map((server) => entryFor(server, installs));
}

/** The entry for one server. */
export function entryFor(server: ServerSummary, installs: ReadonlyMap<string, ToolInstall> = new Map()): StatusEntry {
  if (server.state === "missing") {
    return missingEntry(server, installs);
  }
  if (server.state === "ready" && server.busy) {
    return { id: server.id, text: `${server.name}: ${server.busy}`, tone: "busy", restartable: false, action: null, detail: server.root };
  }
  if (server.state === "ready") {
    return { id: server.id, text: server.name, tone: "good", restartable: false, action: null, detail: server.root };
  }
  if (server.state === "starting") {
    return { id: server.id, text: `${server.name} starting…`, tone: "busy", restartable: false, action: null, detail: server.root };
  }
  if (server.state === "stopped") {
    return { id: server.id, text: `${server.name} stopped`, tone: "quiet", restartable: true, action: "restart", detail: server.root };
  }
  const verb = server.state === "failed" ? "failed to start" : "stopped unexpectedly";
  return {
    id: server.id,
    text: `${server.name} ${verb}, press to restart`,
    tone: "bad",
    restartable: true,
    action: "restart",
    detail: server.message,
  };
}

/** The entry for a server whose program was not found: an offer to install it when Grove can, else the name of what to install. */
function missingEntry(server: ServerSummary, installs: ReadonlyMap<string, ToolInstall>): StatusEntry {
  const tool = server.tool;
  if (tool === undefined || tool === null) {
    return { id: server.id, text: `${server.name} not installed`, tone: "quiet", restartable: true, action: "restart", detail: server.message };
  }
  const install = installs.get(tool);
  if (install !== undefined && install.state === "installing") {
    return { id: server.id, text: `Installing ${server.name}: ${shorten(install.message)}`, tone: "busy", restartable: false, action: null, detail: install.message };
  }
  if (install !== undefined) {
    return { id: server.id, text: `${server.name} install failed, press to retry`, tone: "bad", restartable: true, action: "install", detail: install.message };
  }
  return { id: server.id, text: `${server.name} not installed, press to install`, tone: "quiet", restartable: true, action: "install", detail: server.message };
}

/** A step of an install cut to what fits in the status bar. */
function shorten(message: string): string {
  const limit = 36;
  if (message.length <= limit) {
    return message;
  }
  return `${message.slice(0, limit - 1)}…`;
}
