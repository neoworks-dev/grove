// One session's conversation as a pane draws it: the items the daemon resolved from the session's
// events, replaced whenever they change, and the calls that talk back (send, cancel, press a
// button). It follows the session from `start` until `stop`; the service starts one when the first
// pane shows the session and stops it when the last pane lets go. A chat can also follow one
// agent's work in the session (a subagent or a guest), read-only, for the agents list.

import type { HarnessSettings as OfferedHarness, SessionEventRecord, ViewItem } from "@suite/protocol/types";
import { ViewState } from "@suite/sdk";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import { nextApprovals, type Approvals, type SessionStatus } from "./status";
import { SessionFacts } from "./sessionFacts";
import type { PlanList } from "./plan";
import type { AgentRow } from "./subagents";
import { chainedTexts, type CallDiff, type CallFacts } from "./calls";
import type { Touches } from "./files";
import type { ChatClient } from "./suiteClient";

/** What the client's `input` takes beside the text. */
type InputOptions = NonNullable<Parameters<ChatClient["input"]>[2]>;

/** What a chat follows beyond the session's own view. */
export interface ChatOptions {
  /** Follow only this agent's work in the session, and not the session's events. */
  agent?: string;
  /** Shows a file in the editor; without it, a file name in the chat does nothing when pressed. */
  openFile?: (path: string) => void;
  /** The directory the session works in, which a relative picture path is read from. */
  directory?: () => string | undefined;
  /** Shows how a file changed: against HEAD, or between two texts when they are given. */
  openDiff?: (path: string, texts?: { oldText: string; newText: string }) => void;
}

export class ChatSession {
  readonly sessionId: string;
  private client: ChatClient;
  private view = new ViewState();
  private currentItems: readonly ViewItem[] = [];
  /** The view's items before the setting notices are taken out. */
  private viewItems: readonly ViewItem[] = [];
  private offeredHarnesses: readonly OfferedHarness[] = [];
  private offeredTimer: ReturnType<typeof setTimeout> | undefined;
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

  /** The file changes the session's tool calls made, in the order the calls came. Reactive. */
  fileChanges(): CallDiff[] {
    this.changes.track();
    return [...this.facts.calls.byRef.values()].flatMap((call) => call.diffs);
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

  /** What each harness offers to set (models, efforts), as the daemon last said; empty until asked. Reactive. */
  offered(): readonly OfferedHarness[] {
    this.changes.track();
    return this.offeredHarnesses;
  }

  /** Asks the daemon what the session's harnesses offer to set. A failure leaves the last answer. */
  async loadOffered(): Promise<void> {
    try {
      const reply = await this.client.sessionSettings(this.sessionId);
      // The same answer again would rebuild every open list for nothing.
      if (JSON.stringify(reply.harnesses) === JSON.stringify(this.offeredHarnesses)) {
        return;
      }
      this.offeredHarnesses = reply.harnesses;
      this.changes.notify();
    } catch {
      return;
    }
  }

  /** Asks for the offers once the events that came in together are folded, as a replay brings many. */
  private askOffered(): void {
    if (this.offeredTimer !== undefined) {
      return;
    }
    this.offeredTimer = setTimeout(() => {
      this.offeredTimer = undefined;
      void this.loadOffered();
    }, 0);
  }

  /**
   * The harness the session runs on: the one the daemon marks current, else what the events said
   * last. A session that never switched has no event naming its harness. Reactive.
   */
  harness(): string {
    const current = this.offered().find((entry) => entry.current);
    if (current !== undefined) {
      return current.name;
    }
    return this.status().harness;
  }

  /** Moves the session onto another harness, without a picker in the chat. */
  async setHarness(name: string): Promise<void> {
    await this.send(`/harness ${name}`);
  }

  /** Sets one of the current harness's options (`model`, `effort`, `mode`) to a value. */
  async setOption(option: "model" | "effort" | "mode", value: string): Promise<void> {
    await this.send(`/${option} ${this.harness()} ${value}`);
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

  /**
   * Shows how the file at an absolute path changed, in a diff pane when there is one: what the
   * session's calls made of it when they add up to one change, else the file against HEAD.
   */
  openDiff(path: string): void {
    const texts = chainedTexts(this.fileChanges().filter((change) => change.path === path));
    this.openDiffBetween(path, texts);
  }

  /** Shows a diff between two texts of a file, or the file against HEAD when there are none. */
  openDiffBetween(path: string, texts?: { oldText: string; newText: string }): void {
    if (this.options.openDiff === undefined) {
      this.openFile(path);
      return;
    }
    this.options.openDiff(path, texts);
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
    this.askOffered();
    // The history arrives one event per message, and folding each one in redraws the pane: a long
    // session took seconds to open. So the replay is kept until it is over and folded in at once.
    let replay: SessionEventRecord[] | undefined = [];
    this.stopEvents = this.client.subscribe(this.sessionId, {
      onEvent: (_event, record) => {
        if (replay !== undefined) {
          replay.push(record);
          return;
        }
        this.applyRecords([record]);
      },
      onLive: () => {
        if (replay === undefined) {
          return;
        }
        const records = replay;
        replay = undefined;
        this.applyRecords(records);
      },
      onError: (error) => this.fail(error),
    });
  }

  /** Folds events into the session's facts, and redraws once if any of them changed something. */
  private applyRecords(records: readonly SessionEventRecord[]): void {
    const notices = this.facts.settingNotices;
    let changed = false;
    for (const record of records) {
      if (this.facts.apply(record)) {
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    if (this.facts.settingNotices !== notices) {
      this.currentItems = this.withoutSettingNotices(this.viewItems);
      this.askOffered();
    }
    this.changes.notify();
  }

  /**
   * Sends what the user typed to the session's agent, commands such as `/model` included. `shown`
   * is what the chat displays in place of a text written for the agent; a daemon that does not
   * read it shows the text itself.
   */
  async send(text: string, shown?: string): Promise<void> {
    if (shown === undefined) {
      await this.guard(this.client.input(this.sessionId, text));
      return;
    }
    const options: InputOptions & { shown: string } = { shown };
    await this.guard(this.client.input(this.sessionId, text, options));
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

  /** The directory the session works in, or an empty text while it is not known. */
  directory(): string {
    const directory = this.options.directory?.();
    if (directory === undefined) {
      return "";
    }
    return directory;
  }

  /** Has the daemon download the picture at a web address into its asset store; resolves to the handle. */
  async fetchAsset(url: string): Promise<string> {
    const asset = await this.client.fetchAsset(url);
    return asset.handle;
  }

  /** The source an `Image` loads a picture from: the daemon's URL for an asset handle, else the source as it is. */
  assetSource(source: string): string {
    const served = this.assetSources(source);
    if (served === undefined) {
      return source;
    }
    return served;
  }

  /** Shows a message in the pane's error line, for a failure that did not come from the daemon. */
  reportError(message: string): void {
    this.failure = message;
    this.changes.notify();
  }

  /** Hands the view's items out as a new array, so readers see a change. */
  private publish(): void {
    this.viewItems = [...this.view.items];
    this.currentItems = this.withoutSettingNotices(this.viewItems);
    this.changes.notify();
  }

  /** The items without the notices that announce a setting change, which the composer shows instead. */
  private withoutSettingNotices(items: readonly ViewItem[]): readonly ViewItem[] {
    const hidden = this.facts.settingNotices;
    if (hidden.size === 0) {
      return items;
    }
    return items.filter((item) => item.kind !== "notice" || !hidden.has(item.ref));
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
