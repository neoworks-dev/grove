// What the agents plugin uses of the suite daemon, written down as the parts of the suite's
// own TypeScript client it calls, so tests stand in for the daemon with a fake. The real client
// comes from `@suite/sdk` in `suiteHost.ts`, and nothing else imports that package at run time.

import type { SessionCreateParams, SessionInfo } from "@suite/protocol/types";
import type { Client, ConnectionState, DaemonAddress } from "@suite/sdk";

/** The calls one chat pane makes for its session. */
export type ChatClient = Pick<Client, "subscribeView" | "input" | "cancel" | "action">;

/** The client as the plugin's service uses it: the chat calls and the session list. */
export type SuiteClient = ChatClient &
  Pick<Client, "state" | "sessions" | "listSessions" | "listConnectors" | "setPresence" | "close"> & {
    createSession(params: SessionCreateParams): Promise<SessionInfo>;
  };

/** What a connection is asked to do. */
export interface SuiteConnectOptions {
  /** The name sent to the daemon in hello. */
  client: string;
  /** How long one request may wait for the daemon's answer, its welcome included. */
  requestTimeoutMs: number;
  /** Where the daemon is now; asked again on every reconnect. */
  address: () => Promise<DaemonAddress>;
  /** Failures nobody is waiting for. */
  onError: (error: Error) => void;
}

/** The host side of the suite: where the daemon is, how to start it, and how to connect. */
export interface SuiteHost {
  /** The running daemon's address. Rejects with the code `NotRunning` when there is none. */
  address(): Promise<DaemonAddress>;
  /** Starts the daemon if it is not running, and resolves once it answers. */
  startDaemon(): Promise<void>;
  connect(options: SuiteConnectOptions): Promise<SuiteClient>;
  /** The URL the daemon serves an `asset://` handle from, which holds its token; undefined for any other source. */
  assetUrl(address: DaemonAddress, source: string): string | undefined;
}

export type { ConnectionState, DaemonAddress };
