// A stand-in for the suite daemon and its client, so the agents plugin runs under `bun test`:
// the host answers the daemon's address and start-up from switches, and the client keeps the
// sessions and views a test sets up and records every call made to it.

import type {
  AgentFocus,
  AppPresence,
  Asset,
  AgentMove,
  ConnectorInfo,
  SecretRequest,
  SessionEvent,
  SessionEventRecord,
  SessionInfo,
  ViewItem,
  ViewPatch,
  ViewSnapshot,
} from "@suite/protocol/types";
import type { AppTool, ToolServer } from "../../plugins/agents/contributions";
import type { ConnectionState, DaemonAddress, SuiteClient, SuiteConnectOptions, SuiteHost } from "../../plugins/agents/suiteClient";

/** A value that tells its listeners when it changes, as the client's `Watched`. */
class FakeWatched<Value> {
  value: Value;
  private listeners = new Set<(value: Value) => void>();

  constructor(value: Value) {
    this.value = value;
  }

  on(callback: (value: Value) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Sets a new value and tells every listener. */
  set(value: Value): void {
    this.value = value;
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

/** One view subscription a test can push snapshots and patches into. */
export interface FakeViewSubscription {
  sessionId: string;
  /** The agent whose work the view follows, if it is not the session's own. */
  agent?: string;
  snapshot(snapshot: ViewSnapshot): void;
  patch(patch: ViewPatch): void;
  stopped: boolean;
}

/** One event subscription a test can push the session's events into. */
export interface FakeEventSubscription {
  sessionId: string;
  /** Delivers an event as record number `seq` of the session. */
  emit(event: SessionEvent, seq?: number, ts?: number): void;
  stopped: boolean;
}

/** What a presence call sent. */
export type PresenceCall = AppPresence;

export class FakeClient {
  state = new FakeWatched<ConnectionState>("open");
  sessions = new FakeWatched<SessionInfo[]>([]);
  connectors = new FakeWatched<ConnectorInfo[]>([]);
  presences: PresenceCall[] = [];
  views: FakeViewSubscription[] = [];
  events: FakeEventSubscription[] = [];
  focus = new FakeWatched<AgentFocus | undefined>(undefined);
  moves: AgentMove[] = [];
  contexts: Record<string, string>[] = [];
  inputs: { session: string; text: string; shown?: string; images?: string[] }[] = [];
  cancels: string[] = [];
  actions: { session: string; ref: string; action: string; args?: unknown }[] = [];
  /** The web addresses the chat asked the daemon to download. */
  fetched: string[] = [];
  created: { cwd?: string }[] = [];
  closed = false;
  /** Makes the next call that talks to the daemon reject with this. */
  failNext: Error | null = null;
  /** Makes `listSessions` wait forever, as a daemon that is alive but wedged does. */
  listingHangs = false;

  async listSessions(): Promise<SessionInfo[]> {
    if (this.listingHangs) {
      await new Promise<never>(() => {});
    }
    return this.sessions.value;
  }

  async listConnectors(): Promise<ConnectorInfo[]> {
    return this.connectors.value;
  }

  async setPresence(presence: PresenceCall): Promise<void> {
    this.presences.push(presence);
  }

  async setContext(context: Record<string, string>): Promise<void> {
    this.contexts.push(context);
  }

  async moveAgent(move: AgentMove): Promise<void> {
    this.throwIfFailing();
    this.moves.push(move);
  }

  async createSession(params: { cwd?: string }): Promise<SessionInfo> {
    this.created.push(params);
    const info = sessionInfo({ id: `s_new${this.created.length}`, cwd: params.cwd });
    this.sessions.set([...this.sessions.value, info]);
    return info;
  }

  async input(session: string, text: string, options: { shown?: string; images?: string[] } = {}): Promise<void> {
    this.throwIfFailing();
    const input: { session: string; text: string; shown?: string; images?: string[] } = { session, text };
    if (options.shown !== undefined) {
      input.shown = options.shown;
    }
    if (options.images !== undefined) {
      input.images = options.images;
    }
    this.inputs.push(input);
  }

  async cancel(session: string): Promise<void> {
    this.throwIfFailing();
    this.cancels.push(session);
  }

  private secretListeners = new Set<(request: SecretRequest) => void>();
  /** The answers given to secret questions; a missing value is a question given up. */
  secretAnswers: { id: string; value?: string }[] = [];

  onSecretRequest(callback: (request: SecretRequest) => void): () => void {
    this.secretListeners.add(callback);
    return () => {
      this.secretListeners.delete(callback);
    };
  }

  /** The daemon asks this client for a secret. */
  askSecret(request: SecretRequest): void {
    for (const listener of [...this.secretListeners]) {
      listener(request);
    }
  }

  answerSecret(id: string, value?: string): void {
    this.secretAnswers.push(value === undefined ? { id } : { id, value });
  }

  /** What `unqueue` hands back: the messages this app has waiting. */
  unqueued: { app: string; text: string; images?: string[] }[] = [];

  async unqueue(session: string): Promise<{ app: string; text: string; images?: string[] }[]> {
    this.throwIfFailing();
    this.unqueueCalls.push(session);
    const inputs = this.unqueued;
    this.unqueued = [];
    return inputs;
  }

  unqueueCalls: string[] = [];

  async action(session: string, ref: string, action: string, args?: unknown): Promise<void> {
    this.throwIfFailing();
    this.actions.push({ session, ref, action, args });
  }

  /** Stores nothing: the asset is named after the address, so a test can tell which it got. */
  async fetchAsset(url: string): Promise<Asset> {
    this.throwIfFailing();
    this.fetched.push(url);
    return { handle: `asset://fetched-${this.fetched.length}`, path: "/tmp/fetched", name: url, mime: "image/png", size: 0, createdAt: 0 };
  }

  subscribe(
    sessionId: string,
    options: { onEvent: (event: SessionEvent, record: SessionEventRecord) => void; onLive?: (session: SessionInfo) => void },
  ): () => void {
    let nextSeq = 1;
    const subscription: FakeEventSubscription = {
      sessionId,
      emit: (event, seq, ts) => {
        const number = seq === undefined ? nextSeq : seq;
        nextSeq = number + 1;
        const time = ts === undefined ? 1000 : ts;
        options.onEvent(event, { session: sessionId, seq: number, ts: time, event });
      },
      stopped: false,
    };
    this.events.push(subscription);
    // As the daemon does: what is emitted before this is the replay, what comes after is live.
    queueMicrotask(() => options.onLive?.({ id: sessionId, cwd: "/", createdAt: 0, lastActivity: 0, lastSeq: nextSeq - 1, state: "idle", queued: 0 }));
    return () => {
      subscription.stopped = true;
    };
  }

  subscribeView(
    sessionId: string,
    options: { agent?: string; onSnapshot: (snapshot: ViewSnapshot) => void; onPatch: (patch: ViewPatch) => void },
  ): () => void {
    const subscription: FakeViewSubscription = {
      sessionId,
      agent: options.agent,
      snapshot: (snapshot) => options.onSnapshot(snapshot),
      patch: (patch) => options.onPatch(patch),
      stopped: false,
    };
    this.views.push(subscription);
    return () => {
      subscription.stopped = true;
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** The event subscriptions that are still followed. */
  liveEvents(): FakeEventSubscription[] {
    return this.events.filter((subscription) => !subscription.stopped);
  }

  /** The views that are still followed. */
  liveViews(): FakeViewSubscription[] {
    return this.views.filter((view) => !view.stopped);
  }

  private throwIfFailing(): void {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }
}

/** The host the service connects through: what the address and start-up do is set by the test. */
export class FakeHost implements SuiteHost {
  client = new FakeClient();
  tools = new FakeToolServer();
  /** Whether a daemon is running; `startDaemon` makes it so unless `startFails` is set. */
  running = true;
  startFails: string | null = null;
  /** Holds `connect` until `releaseConnect` is called, as a daemon that accepts and never answers does. */
  private connectGate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  calls: string[] = [];
  connectOptions: SuiteConnectOptions[] = [];

  async address(): Promise<DaemonAddress> {
    this.calls.push("address");
    if (!this.running) {
      throw Object.assign(new Error("the suite daemon is not running"), { code: "NotRunning" });
    }
    return { url: "http://127.0.0.1:4000", token: "token" };
  }

  async startDaemon(): Promise<void> {
    this.calls.push("startDaemon");
    if (this.startFails !== null) {
      throw new Error(this.startFails);
    }
    this.running = true;
  }

  /** Makes the next `connect` wait until `releaseConnect`. */
  holdConnect(): void {
    this.connectGate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  /** Lets the held `connect` finish. */
  releaseConnect(): void {
    this.releaseGate?.();
    this.connectGate = null;
  }

  async connect(options: SuiteConnectOptions): Promise<SuiteClient> {
    this.calls.push("connect");
    this.connectOptions.push(options);
    if (this.connectGate !== null) {
      await this.connectGate;
    }
    return this.client as unknown as SuiteClient;
  }

  toolServer(): ToolServer {
    return this.tools;
  }

  assetUrl(address: DaemonAddress, source: string): string | undefined {
    if (!source.startsWith("asset://")) {
      return undefined;
    }
    return `${address.url}/assets/${source.slice("asset://".length)}?token=${address.token}`;
  }
}

/** A session as the daemon lists it, with the fields a test does not care about filled in. */
export function sessionInfo(fields: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    cwd: "/repo",
    createdAt: 1,
    lastActivity: 1,
    lastSeq: 0,
    state: "idle",
    queued: 0,
    ...fields,
  };
}

/** An agent message item with a single paragraph, as the daemon's view resolves one. */
export function agentItem(ref: string, text: string): ViewItem {
  return {
    ref,
    kind: "agent",
    component: { type: "text", blocks: [{ type: "paragraph", spans: [{ text }] }] },
  };
}

/** The host's tool server, with the tools it was given and a way to call them as the gateway does. */
export class FakeToolServer implements ToolServer {
  /** The tool lists the service asked to serve, oldest first. */
  served: (readonly AppTool[])[] = [];
  /** Makes the next `serve` reject with this. */
  failNext: Error | null = null;

  async serve(tools: readonly AppTool[]): Promise<{ url: string; headers: Record<string, string> }> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.served.push(tools);
    return { url: `http://127.0.0.1:1/mcp?v=${this.served.length}`, headers: { Authorization: "Bearer token" } };
  }

  /** Calls a tool of the latest list as the gateway's `tools/call` does. */
  call(name: string, args: Record<string, unknown>): Promise<string> {
    const latest = this.served[this.served.length - 1];
    const tool = latest.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return tool.run(args);
  }
}
