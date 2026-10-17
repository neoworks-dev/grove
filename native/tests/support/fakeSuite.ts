// A stand-in for the suite daemon and its client, so the agents plugin runs under `bun test`:
// the host answers the daemon's address and start-up from switches, and the client keeps the
// sessions and views a test sets up and records every call made to it.

import type { ConnectorInfo, SessionInfo, ViewItem, ViewPatch, ViewSnapshot } from "@suite/protocol/types";
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
  snapshot(snapshot: ViewSnapshot): void;
  patch(patch: ViewPatch): void;
  stopped: boolean;
}

/** What a presence call sent. */
export interface PresenceCall {
  app: string;
  context?: Record<string, string>;
}

export class FakeClient {
  state = new FakeWatched<ConnectionState>("open");
  sessions = new FakeWatched<SessionInfo[]>([]);
  connectors: ConnectorInfo[] = [];
  presences: PresenceCall[] = [];
  views: FakeViewSubscription[] = [];
  inputs: { session: string; text: string }[] = [];
  cancels: string[] = [];
  actions: { session: string; ref: string; action: string; args?: unknown }[] = [];
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
    return this.connectors;
  }

  async setPresence(presence: PresenceCall): Promise<void> {
    this.presences.push(presence);
  }

  async createSession(params: { cwd?: string }): Promise<SessionInfo> {
    this.created.push(params);
    const info = sessionInfo({ id: `s_new${this.created.length}`, cwd: params.cwd });
    this.sessions.set([...this.sessions.value, info]);
    return info;
  }

  async input(session: string, text: string): Promise<void> {
    this.throwIfFailing();
    this.inputs.push({ session, text });
  }

  async cancel(session: string): Promise<void> {
    this.throwIfFailing();
    this.cancels.push(session);
  }

  async action(session: string, ref: string, action: string, args?: unknown): Promise<void> {
    this.throwIfFailing();
    this.actions.push({ session, ref, action, args });
  }

  subscribeView(
    sessionId: string,
    options: { onSnapshot: (snapshot: ViewSnapshot) => void; onPatch: (patch: ViewPatch) => void },
  ): () => void {
    const subscription: FakeViewSubscription = {
      sessionId,
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
