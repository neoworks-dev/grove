// The `sidecar` service: Grove's main process as the rest of the UI sees it. It wraps the
// sidecar client so plugins call routes and listen to events, and it knows whether the
// sidecar is up. A sidecar that is starting or has ended does not break the plugins that
// depend on it: their calls reject with `SidecarUnavailableError`, which they show as a state
// of their own, and `status()` tells the status bar what to say.

import { Service, type Context } from "@neoworks/extension-system";
import type { WorkbenchApi } from "../../../src/preload/index.d";
import type { SidecarClient, SidecarInfo, SidecarStatus as HostStatus } from "../../sidecar-client";
import { createWorkbench } from "../../sidecar-client/workbench";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";

declare module "@neoworks/extension-system" {
  interface Context {
    sidecar: SidecarService;
  }
}

/** The part of the sidecar client the service uses, so tests can stand in for it. */
export type SidecarLink = Pick<SidecarClient, "call" | "on" | "onExit"> & {
  info(): Promise<SidecarInfo>;
  status(): Promise<HostStatus>;
};

export interface SidecarState {
  state: "starting" | "running" | "exited";
  /** Why it ended, or why it did not start. */
  message?: string;
}

/** Thrown by calls made while the sidecar is not running. */
export class SidecarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarUnavailableError";
  }
}

export class SidecarService extends Service {
  /** `window.workbench` for the native UI: every route as a method, gated on the sidecar being up. */
  readonly workbench: WorkbenchApi;
  private link: SidecarLink;
  private current: SidecarState = { state: "starting" };
  private changes: ChangeSignal = createChangeSignal();
  /** Calls made while the sidecar was starting, waiting to learn whether it came up. */
  private waiting: (() => void)[] = [];

  constructor(ctx: Context, link: SidecarLink) {
    super(ctx, "sidecar");
    this.link = link;
    this.workbench = createWorkbench({
      call: (channel, ...args) => this.call(channel, ...args),
      on: (channel, handler) => this.on(channel, handler),
    });
    ctx.effect(() => link.onExit((exit) => this.settle({ state: "exited", message: exit.message })), "sidecar exit");
    void this.connect();
  }

  /** Whether the sidecar is up and answering. Reactive. */
  isRunning(): boolean {
    return this.status().state === "running";
  }

  /** How the sidecar is doing. Reactive. */
  status(): SidecarState {
    this.changes.track();
    return this.current;
  }

  /** Calls a route. Rejects with `SidecarUnavailableError` while the sidecar is not running. */
  async call<Result = unknown>(channel: string, ...args: unknown[]): Promise<Result> {
    const state = this.current;
    if (state.state === "exited") {
      throw new SidecarUnavailableError(describeExit(state));
    }
    if (state.state === "starting") {
      await this.untilSettled();
      return this.call<Result>(channel, ...args);
    }
    return this.link.call<Result>(channel, ...args);
  }

  /**
   * Listens to an event the sidecar pushes. The listener leaves with the calling plugin, or
   * when the returned function is called.
   */
  on(channel: string, handler: (payload: unknown) => void): () => void {
    return this.ctx.effect(() => this.link.on(channel, handler), `sidecar.on(${channel})`);
  }

  /** Waits for the sidecar to finish starting, or learns that it ended instead. */
  private async connect(): Promise<void> {
    try {
      const host = await this.link.status();
      if (host.state !== "running") {
        this.settle({ state: "exited", message: host.message ?? "the sidecar is not running" });
        return;
      }
      await this.link.info();
      this.settle({ state: "running" });
    } catch (error) {
      this.settle({ state: "exited", message: describeError(error) });
    }
  }

  /** Records a new state, except that an ended sidecar stays ended. */
  private settle(next: SidecarState): void {
    if (this.current.state === "exited") {
      return;
    }
    this.current = next;
    this.changes.notify();
    this.release();
  }

  /** Resolves once the state is no longer "starting". */
  private untilSettled(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /** Wakes the calls that waited for the sidecar to start. */
  private release(): void {
    for (const resolve of this.waiting.splice(0)) {
      resolve();
    }
  }
}

/** The sentence a rejected call carries. */
function describeExit(state: SidecarState): string {
  if (state.message) {
    return `the sidecar is not running: ${state.message}`;
  }
  return "the sidecar is not running";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
