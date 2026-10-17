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
}

/** Which colour name the status dot of a server is drawn in. */
export type StatusTone = "good" | "busy" | "bad" | "quiet";

/** One server as one entry of the status bar. */
export interface StatusEntry {
  id: number;
  text: string;
  tone: StatusTone;
  /** Whether pressing it does something: starting a server that is down. */
  restartable: boolean;
  /** The longer explanation, for a place to show it. */
  detail: string;
}

/** The status bar's entries for the servers, in the order they started. */
export function statusEntries(servers: ServerSummary[]): StatusEntry[] {
  return servers.map(entryFor);
}

/** The entry for one server. */
export function entryFor(server: ServerSummary): StatusEntry {
  if (server.state === "ready" && server.busy) {
    return { id: server.id, text: `${server.name}: ${server.busy}`, tone: "busy", restartable: false, detail: server.root };
  }
  if (server.state === "ready") {
    return { id: server.id, text: server.name, tone: "good", restartable: false, detail: server.root };
  }
  if (server.state === "starting") {
    return { id: server.id, text: `${server.name} starting…`, tone: "busy", restartable: false, detail: server.root };
  }
  if (server.state === "missing") {
    return { id: server.id, text: `${server.name} not installed`, tone: "quiet", restartable: true, detail: server.message };
  }
  if (server.state === "stopped") {
    return { id: server.id, text: `${server.name} stopped`, tone: "quiet", restartable: true, detail: server.root };
  }
  const verb = server.state === "failed" ? "failed to start" : "stopped unexpectedly";
  return { id: server.id, text: `${server.name} ${verb}, press to restart`, tone: "bad", restartable: true, detail: server.message };
}
