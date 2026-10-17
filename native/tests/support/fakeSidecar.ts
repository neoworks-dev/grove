// A stand-in for the sidecar client and the services built on it, so the plugins that talk to
// the sidecar run under `bun test` with routes answered from a table.

import { Context } from "@neoworks/extension-system";
import type { SidecarExit, SidecarStatus } from "../../sidecar-client";
import { SidecarService, type SidecarLink } from "../../plugins/sidecar/service";
import { WorkspaceService } from "../../plugins/workspace/service";

export type Route = (...args: unknown[]) => unknown;

/** A sidecar link that answers each route from `routes` and records every call. */
export class FakeLink implements SidecarLink {
  routes: Record<string, Route>;
  calls: { channel: string; args: unknown[] }[] = [];
  hostStatus: SidecarStatus = { state: "running" };
  /** Resolves `info()` once released, to hold the sidecar in its starting state. */
  private infoGate: Promise<void> = Promise.resolve();
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private exitListeners = new Set<(exit: SidecarExit) => void>();

  constructor(routes: Record<string, Route> = {}) {
    this.routes = routes;
  }

  /** Holds `info()` until the returned function is called. */
  holdStart(): () => void {
    let release!: () => void;
    this.infoGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async call<Result = unknown>(channel: string, ...args: unknown[]): Promise<Result> {
    this.calls.push({ channel, args });
    const route = this.routes[channel];
    if (!route) {
      throw new Error(`no route ${channel}`);
    }
    return (await route(...args)) as Result;
  }

  /** The channels called, in order. */
  channelsCalled(): string[] {
    return this.calls.map((call) => call.channel);
  }

  on(channel: string, handler: (payload: unknown) => void): () => void {
    const handlers = this.listeners.get(channel) ?? new Set();
    handlers.add(handler);
    this.listeners.set(channel, handlers);
    return () => handlers.delete(handler);
  }

  /** How many listeners an event has. */
  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  /** Delivers an event as the sidecar would push it. */
  emit(channel: string, payload: unknown): void {
    for (const handler of [...(this.listeners.get(channel) ?? [])]) {
      handler(payload);
    }
  }

  onExit(handler: (exit: SidecarExit) => void): () => void {
    this.exitListeners.add(handler);
    return () => this.exitListeners.delete(handler);
  }

  /** Ends the sidecar, as the host reports it. */
  exit(message: string): void {
    for (const handler of [...this.exitListeners]) {
      handler({ code: null, message });
    }
  }

  async info() {
    await this.infoGate;
    return { pid: 1, platform: "test", channels: [] };
  }

  async status(): Promise<SidecarStatus> {
    return this.hostStatus;
  }
}

/** Lets promise callbacks and zero-delay timers run. */
export function settle(milliseconds = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** What a stand-in `profile` service records. */
export interface FakeProfile {
  folders: (string | null)[];
  setProjectFolder(folder: string | null): Promise<void>;
}

export function createFakeProfile(): FakeProfile {
  const profile: FakeProfile = {
    folders: [],
    async setProjectFolder(folder) {
      profile.folders.push(folder);
    },
  };
  return profile;
}

export interface Harness {
  root: Context;
  link: FakeLink;
  sidecar: SidecarService;
  profile: FakeProfile;
}

/** A root context with the sidecar service over a fake link and a stand-in profile service. */
export async function bootSidecar(routes: Record<string, Route> = {}): Promise<Harness> {
  const root = new Context();
  const link = new FakeLink(routes);
  const profile = createFakeProfile();
  let sidecar!: SidecarService;
  await root.plugin({
    name: "sidecar",
    apply(ctx: Context) {
      sidecar = new SidecarService(ctx, link);
    },
  });
  await root.plugin({
    name: "profile",
    apply(ctx: Context) {
      ctx.provide("profile", profile);
    },
  });
  await settle();
  return { root, link, sidecar, profile };
}

/** The harness plus a workspace service, which the views' services read the shown worktree from. */
export async function bootWorkspace(
  routes: Record<string, Route> = {}
): Promise<Harness & { workspace: WorkspaceService }> {
  const harness = await bootSidecar(routes);
  let workspace!: WorkspaceService;
  await harness.root.plugin({
    name: "workspace",
    inject: ["sidecar", "profile"],
    apply(ctx: Context) {
      workspace = new WorkspaceService(ctx);
    },
  });
  return { ...harness, workspace };
}
