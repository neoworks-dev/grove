// One session's conversation as a pane draws it: the items the daemon resolved from the session's
// events, replaced whenever they change, and the calls that talk back (send, cancel, press a
// button). It follows the session from `start` until `stop`; the service starts one when the first
// pane shows the session and stops it when the last pane lets go. A chat can also follow one
// agent's work in the session (a subagent or a guest), read-only, for the agents list.

import type { ViewItem } from "@suite/protocol/types";
import { ViewState } from "@suite/sdk";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import { nextApprovals, type Approvals, type SessionStatus } from "./status";
import { SessionFacts } from "./sessionFacts";
import type { PlanList } from "./plan";
import type { AgentRow } from "./subagents";
import type { CallFacts } from "./calls";
import type { Touches } from "./files";
import type { ChatClient } from "./suiteClient";

/** What a chat follows beyond the session's own view. */
export interface ChatOptions {
  /** Follow only this agent's work in the session, and not the session's events. */
  agent?: string;
  /** Shows a file in the editor; without it, a file name in the chat does nothing when pressed. */
  openFile?: (path: string) => void;
}

export class ChatSession {
  readonly sessionId: string;
  private client: ChatClient;
  private view = new ViewState();
  private currentItems: readonly ViewItem[] = [];
  private failure: string | null = null;
  private stopFollowing: (() => void) | null = null;
  private stopEvents: (() => void) | null = null;
  private assetSources: (source: string) => string | undefined;
  private options: ChatOptions;
  private facts = new SessionFacts();
  private answering: ReadonlySet<string> = new Set();
  private changes: ChangeSignal = createChangeSignal();

  /** `assetSources` turns an `asset://` handle into the URL the daemon serves it from, if it can. */
  constructor(
    client: ChatClient,
    sessionId: string,
    assetSources: (source: string) => string | undefined,
    options: ChatOptions = {},
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.assetSources = assetSources;
    this.options = options;
  }

  /** The agent this chat follows, or undefined for the session's own conversation. */
  get agent(): string | undefined {
    return this.options.agent;
  }

  /** Whether a turn is running, from the session's events. Reactive. */
  running(): boolean {
    this.changes.track();
    return this.facts.status.running;
  }

  /** The session's status folded from its events: harness, approvals, usage. Reactive. */
  status(): SessionStatus {
    this.changes.track();
    return this.facts.status;
  }

  /** The approvals mode the session is in. Reactive. */
  approvals(): Approvals {
    return this.status().approvals;
  }

  /** The todo lists of the session's agents. Reactive. */
  plans(): readonly PlanList[] {
    this.changes.track();
    return this.facts.plans;
  }

  /** The files the session's agents touched. Reactive. */
  touches(): Touches {
    this.changes.track();
    return this.facts.touches;
  }

  /** What the events say about the tool call whose chat item has this ref, or undefined for anything else. Reactive. */
  callOf(ref: string): CallFacts | undefined {
    this.changes.track();
    return this.facts.calls.byRef.get(ref);
  }

  /** The subagents and guests working for the session, finished ones included. Reactive. */
  agentRows(): readonly AgentRow[] {
    this.changes.track();
    return this.facts.agents;
  }

  /** Whether the composer is answering the question in item `ref`, so the chat shows a stub for it. Reactive. */
  isAnswering(ref: string): boolean {
    this.changes.track();
    return this.answering.has(ref);
  }

  /** Marks question `ref` as answered in the composer, or, with undefined, no question. */
  setAnswering(ref: string | undefined): void {
    const next = new Set<string>();
    if (ref !== undefined) {
      next.add(ref);
    }
    if (next.size === this.answering.size && [...next].every((entry) => this.answering.has(entry))) {
      return;
    }
    this.answering = next;
    this.changes.notify();
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

  /** Shows the file at an absolute path in the editor. */
  openFile(path: string): void {
    if (this.options.openFile === undefined) {
      return;
    }
    this.options.openFile(path);
  }

  /** Starts following the session's view: a snapshot first, then patches. */
  start(): void {
    if (this.stopFollowing !== null) {
      return;
    }
    this.followEvents();
    this.stopFollowing = this.client.subscribeView(this.sessionId, {
      agent: this.options.agent,
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
    if (this.stopEvents !== null) {
      this.stopEvents();
      this.stopEvents = null;
    }
    if (this.stopFollowing === null) {
      return;
    }
    this.stopFollowing();
    this.stopFollowing = null;
  }

  /** Follows the session's events for what they say beyond the chat; an agent's own chat has no use for them. */
  private followEvents(): void {
    if (this.options.agent !== undefined) {
      return;
    }
    this.stopEvents = this.client.subscribe(this.sessionId, {
      onEvent: (_event, record) => {
        if (this.facts.apply(record)) {
          this.changes.notify();
        }
      },
      onError: (error) => this.fail(error),
    });
  }

  /** Sends what the user typed to the session's agent, commands such as `/model` included. */
  async send(text: string): Promise<void> {
    await this.guard(this.client.input(this.sessionId, text));
  }

  /** Cancels the turn that is running. Inputs queued behind it still run. */
  async cancel(): Promise<void> {
    await this.guard(this.client.cancel(this.sessionId));
  }

  /** Switches the session to the next approvals mode (ask, review, edits, auto). */
  async cycleApprovals(): Promise<void> {
    await this.send(`/approvals ${nextApprovals(this.approvals())}`);
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
