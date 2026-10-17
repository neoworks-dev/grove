// One session's conversation as a pane draws it: the items the daemon resolved from the session's
// events, replaced whenever they change, and the calls that talk back (send, cancel, press a
// button). It follows the session from `start` until `stop`; the service starts one when the first
// pane shows the session and stops it when the last pane lets go.

import type { ViewItem } from "@suite/protocol/types";
import { ViewState } from "@suite/sdk";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { ChatClient } from "./suiteClient";

export class ChatSession {
  readonly sessionId: string;
  private client: ChatClient;
  private view = new ViewState();
  private currentItems: readonly ViewItem[] = [];
  private failure: string | null = null;
  private stopFollowing: (() => void) | null = null;
  private assetSources: (source: string) => string | undefined;
  private changes: ChangeSignal = createChangeSignal();

  /** `assetSources` turns an `asset://` handle into the URL the daemon serves it from, if it can. */
  constructor(client: ChatClient, sessionId: string, assetSources: (source: string) => string | undefined) {
    this.client = client;
    this.sessionId = sessionId;
    this.assetSources = assetSources;
  }

  /** The conversation so far, replaced and never mutated on each change. Reactive. */
  items(): readonly ViewItem[] {
    this.changes.track();
    return this.currentItems;
  }

  /** Why the daemon last refused a call, or null. Reactive. */
  error(): string | null {
    this.changes.track();
    return this.failure;
  }

  /** Dismisses the error. */
  clearError(): void {
    this.failure = null;
    this.changes.notify();
  }

  /** Starts following the session's view: a snapshot first, then patches. */
  start(): void {
    if (this.stopFollowing !== null) {
      return;
    }
    this.stopFollowing = this.client.subscribeView(this.sessionId, {
      onSnapshot: (snapshot) => {
        this.view.applySnapshot(snapshot);
        this.publish();
      },
      onPatch: (patch) => {
        if (this.view.applyPatch(patch).length > 0) {
          this.publish();
        }
      },
      onError: (error) => this.fail(error),
    });
  }

  /** Stops following the session. */
  stop(): void {
    if (this.stopFollowing === null) {
      return;
    }
    this.stopFollowing();
    this.stopFollowing = null;
  }

  /** Sends what the user typed to the session's agent, commands such as `/model` included. */
  async send(text: string): Promise<void> {
    await this.guard(this.client.input(this.sessionId, text));
  }

  /** Cancels the turn that is running. Inputs queued behind it still run. */
  async cancel(): Promise<void> {
    await this.guard(this.client.cancel(this.sessionId));
  }

  /** Reports that a button was pressed in the item `ref`; `args` carries a note for the agent. */
  async action(ref: string, action: string, args?: unknown): Promise<void> {
    await this.guard(this.client.action(this.sessionId, ref, action, args));
  }

  /** The source an `Image` loads a picture from: the daemon's URL for an asset handle, else the source as it is. */
  assetSource(source: string): string {
    const served = this.assetSources(source);
    if (served === undefined) {
      return source;
    }
    return served;
  }

  /** Hands the view's items out as a new array, so readers see a change. */
  private publish(): void {
    this.currentItems = [...this.view.items];
    this.changes.notify();
  }

  /** Awaits a call to the daemon and keeps its failure for the pane to show. */
  private async guard(request: Promise<void>): Promise<void> {
    try {
      await request;
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.failure !== null) {
      this.clearError();
    }
  }

  /** Records a failure as a sentence. */
  private fail(error: unknown): void {
    if (error instanceof Error) {
      this.failure = error.message;
    } else {
      this.failure = String(error);
    }
    this.changes.notify();
  }
}
