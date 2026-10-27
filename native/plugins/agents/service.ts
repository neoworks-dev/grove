// The `agents` service: Grove as one more client of the neoworks-harness suite daemon. It
// connects to the daemon (starting it when it is not running), keeps the session list the
// daemon announces, and puts a session's chat into a pane of the main area. Everything the
// panes and the sessions view draw comes from here, and every call to the daemon goes through
// the client the host connected, so tests stand in for the daemon.
//
// A chat pane is a leaf of the layout whose type is `agent` and whose state names its session.
// The service follows a session while at least one pane shows it.

import { Service, type Context } from "@neoworks/extension-system";
import type { AgentFocus, AppPresence, ConnectorInfo, SecretRequest, SessionInfo } from "@suite/protocol/types";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import type { SplitDirection } from "../layout/layoutTree";
import type { Worktree } from "../../../src/shared/types";
import { ChatSession } from "./chatSession";
import { NamedRegistry, type AppComponent, type AppTool } from "./contributions";
import { showEditQuestion, type EditDiffOpener, type ShownEdit } from "./editDiffs";
import type { EditQuestion } from "./editQuestions";
import { groupSessions, sessionTitle, siblingsOf, type SessionGroup } from "./sessions";
import type { ConnectionState, DaemonAddress, SuiteClient, SuiteHost } from "./suiteClient";

declare module "@neoworks/extension-system" {
  interface Context {
    agents: AgentsService;
  }
}

/** The pane type of an agent chat, the key of its entry in the `main` slot. */
export const AGENT_PANE_TYPE = "agent";

/** What the client is called in the daemon's hello, and the connector name its windows register under. */
const CLIENT_NAME = "grove";

/** How long the service waits on the daemon before it says the daemon is unavailable. */
export interface AgentsTiming {
  /** The whole start-up: finding the daemon, starting it, connecting and listing sessions. */
  connectTimeoutMs: number;
  /** How long one request may wait for an answer. */
  requestTimeoutMs: number;
  /** How long a dropped connection may keep trying before the service gives up on it. */
  reconnectTimeoutMs: number;
  /** After giving up on a dropped connection, how long before the first new attempt; each failed attempt doubles it. */
  retryInitialMs: number;
  /** The longest the wait between two attempts grows to. */
  retryMaxMs: number;
}

const DEFAULT_TIMING: AgentsTiming = {
  connectTimeoutMs: 20_000,
  requestTimeoutMs: 8_000,
  reconnectTimeoutMs: 30_000,
  retryInitialMs: 2_000,
  retryMaxMs: 60_000,
};

/** How the connection to the daemon is doing. */
export interface AgentsState {
  /** `idle` until something needs the daemon; `unavailable` when it is not running and could not be started. */
  connection: "idle" | "starting" | "connecting" | "open" | "reconnecting" | "unavailable";
  /** Why the daemon is unavailable, or the last failure nobody was waiting for. */
  message?: string;
  /** While the service waits to try again by itself: when it will, in milliseconds since the epoch. */
  retryAt?: number;
}

/** The part of the layout the service drives. */
export interface AgentPanes {
  readonly focusedLeafId: string;
  leafIds(): string[];
  paneTypeOf(leafId: string): string | undefined;
  paneState(leafId: string): Record<string, unknown>;
  setPaneState(leafId: string, patch: Record<string, unknown>): void;
  splitFocused(direction: SplitDirection, paneTypeId?: string): void;
  focus(leafId: string): void;
  onPaneSplit(listener: (newLeafId: string, sourceLeafId: string) => void): () => void;
}

/** The part of the workspace the service reads: where sessions belong. */
export interface AgentWorkspace {
  worktrees(): Worktree[];
  selectedWorktree(): Worktree | null;
  /** Calls the listener when another worktree is selected; returns the call that stops it. */
  onSelectionChange(listener: () => void): () => void;
}

/** How the chat shows a file or a change in the rest of the app. */
export interface Openers {
  /** Shows the file at an absolute path in the editor. */
  openFile(path: string): void;
  /** Shows the file at an absolute path with the cursor on a line, counted from one. Resolves once it is shown. */
  revealFile(path: string, line: number): Promise<void>;
  /**
   * Shows a diff in a pane: the file against HEAD, or the two texts when they are given. False
   * when the app has no diff view, which leaves the caller to show the file instead.
   */
  openDiff(path: string, texts?: { oldText: string; newText: string }): boolean;
  /** Shows an edit the agent asks about as a diff in the editor, until it is closed again. */
  showEditQuestion(question: EditQuestion): ShownEdit;
  /**
   * Shows an issue or a pull request in a GitHub pane. `repo` is `owner/name`; `kind` null looks
   * up which the number is. False when the app has no GitHub pane or none could be made.
   */
  openGithubItem(request: GithubItemRequest): Promise<boolean>;
  /** Every file below a directory, relative to it, for `@` mentions; empty when there is no way to list them. */
  listFiles(directory: string): Promise<readonly string[]>;
}

/** An issue or pull request the chat asks to be shown in Grove. */
export interface GithubItemRequest {
  repo: string;
  number: number;
  kind: "issue" | "pull" | null;
}

/** What the editor plugin offers the chat. */
export interface EditorOpener {
  open(path: string): unknown;
  /** Opens a file and puts the cursor at a line and UTF-16 column, both counted from zero. */
  reveal(path: string, line: number, character: number): Promise<void>;
}

/** What the diff plugin offers the chat. */
export interface DiffOpener extends EditDiffOpener {
  /** Shows how a file differs from HEAD, or from a text a caller names, drawn over the file in an editor. */
  showInEditor(path: string, base?: { text: string; label: string }): Promise<boolean>;
}

/** What the GitHub plugin offers the chat. */
export interface GithubOpener {
  /** Shows an item in a GitHub pane; resolves to the pane, or null when none could be made. */
  openItem(request: GithubItemRequest): Promise<string | null>;
}

/** Openers for a service started without the editor and diff views, as in tests: nothing opens. */
const NO_OPENERS: Openers = {
  openFile: () => {},
  revealFile: async () => {},
  openDiff: () => false,
  showEditQuestion: () => ({ opened: Promise.resolve(), close: () => {} }),
  openGithubItem: async () => false,
  listFiles: async () => [],
};

/** What the ripgrep service lists for `@` mentions. */
export interface FileLister {
  listFiles(directory: string): Promise<{ files: readonly string[] }>;
}

/** The editor, diff, GitHub and ripgrep services as the chat opens things in them. */
export function serviceOpeners(editor: EditorOpener, diff: DiffOpener, github: GithubOpener, ripgrep?: FileLister): Openers {
  return {
    listFiles: async (directory) => {
      if (ripgrep === undefined) {
        return [];
      }
      return (await ripgrep.listFiles(directory)).files;
    },
    openFile: (path) => {
      editor.open(path);
    },
    revealFile: (path, line) => {
      return editor.reveal(path, Math.max(0, line - 1), 0);
    },
    openDiff: (path, texts) => {
      if (texts === undefined) {
        void diff.showInEditor(path);
        return true;
      }
      void diff.showInEditor(path, { text: texts.oldText, label: "the agent's start" });
      return true;
    },
    showEditQuestion: (question) => showEditQuestion(diff, question),
    openGithubItem: async (request) => {
      const leafId = await github.openItem(request);
      return leafId !== null;
    },
  };
}

/** Whether a directory is a worktree's root or inside it. */
function isWithin(worktreePath: string, directory: string): boolean {
  return directory === worktreePath || directory.startsWith(`${worktreePath}/`);
}

/** The wait before an automatic attempt: the first one after the connection was lost, then twice the one before, up to the longest. */
export function nextRetryDelay(previousMs: number, initialMs: number, maxMs: number): number {
  if (previousMs === 0) {
    return Math.min(initialMs, maxMs);
  }
  return Math.min(previousMs * 2, maxMs);
}

/** What a pane's own view lets the service do when a key asks for it. */
export interface PaneHandle {
  /** Shows or hides the plan and files. */
  togglePanel(): void;
  /** Puts the keyboard in the list of the session's agents; false when there is none to move through. */
  focusAgents(): boolean;
}

/** A session some pane shows: how many do, and its chat once the daemon is connected. */
interface FollowedChat {
  chat: ChatSession | null;
  panes: number;
}

export class AgentsService extends Service {
  private openers: Openers;
  private host: SuiteHost;
  private panes: AgentPanes;
  private workspace: AgentWorkspace;
  private client: SuiteClient | null = null;
  private starting: Promise<void> | null = null;
  private current: AgentsState = { connection: "idle" };
  private sessionList: readonly SessionInfo[] = [];
  private connectorList: readonly ConnectorInfo[] = [];
  /** What the daemon asks this window for in secret, such as an API key typed for `/login`; never logged or kept past its answer. */
  private secretRequests: readonly SecretRequest[] = [];
  private stopSecrets: (() => void) | null = null;
  private address: DaemonAddress | null = null;
  private appName = CLIENT_NAME;
  /** The neoui components Grove offers the agent, and the tools their buttons call. */
  private components = new NamedRegistry<AppComponent>("component");
  private tools = new NamedRegistry<AppTool>("tool");
  /** Whether a tool list was ever sent, so that taking the last tool away is sent too. */
  private toolsServed = false;
  private followed = new Map<string, FollowedChat>();
  private paneHandles = new Map<string, PaneHandle>();
  /** Sessions whose tab the user closed, for this run of the app. */
  private closedTabs: ReadonlySet<string> = new Set();
  private changes: ChangeSignal = createChangeSignal();
  private timing: AgentsTiming;
  /** Counts connection attempts, so one that gave up cannot adopt its client when it finally answers. */
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wait before the next automatic attempt, doubled after each one that fails; 0 while none is under way. */
  private retryDelayMs = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the daemon knows this window, so its context can change and the agent can be moved here. */
  private registered = false;
  /** The session the agent was last told to be in, or last found in, for this window. */
  private shownSession: string | null = null;
  /** The session this window asked the agent to move to, until the daemon says it is there. */
  private movingTo: string | null = null;

  constructor(
    ctx: Context,
    host: SuiteHost,
    panes: AgentPanes,
    workspace: AgentWorkspace,
    timing: AgentsTiming = DEFAULT_TIMING,
    openers: Openers = NO_OPENERS,
  ) {
    super(ctx, "agents");
    this.openers = openers;
    this.host = host;
    this.panes = panes;
    this.workspace = workspace;
    this.timing = timing;
    ctx.effect(() => panes.onPaneSplit((newLeafId, sourceLeafId) => this.paneSplit(newLeafId, sourceLeafId)), "agents.paneSplit");
    ctx.effect(() => workspace.onSelectionChange(() => void this.updateContext()), "agents.worktreeChanged");
    ctx.effect(() => this.components.onChange(() => void this.resendPresence()), "agents.componentsChanged");
    ctx.effect(() => this.tools.onChange(() => void this.resendPresence()), "agents.toolsChanged");
    ctx.effect(() => () => this.disconnect(), "agents.disconnect");
  }

  /**
   * Offers the agent neoui components, written `grove.<Name>`, and sends the daemon the new set
   * when this window is connected. Returns the call that takes them away again.
   */
  registerComponents(components: Record<string, AppComponent>): () => void {
    return this.components.add(components);
  }

  /** Offers tools to the agent and to the buttons of the components, as `grove.<name>`. Returns the call that takes them away. */
  registerTools(tools: readonly AppTool[]): () => void {
    const byName: Record<string, AppTool> = {};
    for (const tool of tools) {
      byName[tool.name] = tool;
    }
    return this.tools.add(byName);
  }

  /** Shows the file at an absolute path in the editor with the cursor on a line, counted from one. */
  revealFile(path: string, line: number): Promise<void> {
    return this.openers.revealFile(path, line);
  }

  /** Shows an issue or a pull request in a GitHub pane; false when the app has none. */
  openGithubItem(request: GithubItemRequest): Promise<boolean> {
    return this.openers.openGithubItem(request);
  }

  /** The absolute path a tool call names: a relative one is taken from the shown worktree. Throws when there is none to take it from. */
  resolvePath(path: string): string {
    if (path.startsWith("/")) {
      return path;
    }
    const selected = this.workspace.selectedWorktree();
    if (selected === null) {
      throw new Error(`no repository is open to resolve ${path} in`);
    }
    return `${selected.path}/${path}`;
  }

  /** Shows the file at an absolute path in the editor, when an editor plugin is loaded. */
  openFile(path: string): void {
    this.openers.openFile(path);
  }

  /**
   * Shows how a file changed in a diff tab: against HEAD, or between the two texts a tool call
   * reported when they are given. Without a diff view the file itself is shown.
   */
  openDiff(path: string, texts?: { oldText: string; newText: string }): void {
    if (this.openers.openDiff(path, texts)) {
      return;
    }
    this.openers.openFile(path);
  }

  /**
   * Shows an edit a session's agent asks about as a diff tab in the editor. Opening it focuses the
   * editor, so the focus then goes to the pane that shows the session, where the question is
   * answered. Returns the function that takes the diff away again.
   */
  showEditQuestion(sessionId: string, question: EditQuestion): () => void {
    const shown = this.openers.showEditQuestion(question);
    void shown.opened.then(() => {
      const chatLeafId = this.paneOfSession(sessionId);
      if (chatLeafId !== null) {
        this.panes.focus(chatLeafId);
      }
    });
    return () => shown.close();
  }

  /** The pane that shows a session's chat, the focused one when several do, or null when none does. */
  private paneOfSession(sessionId: string): string | null {
    const showing = this.panes
      .leafIds()
      .filter((leafId) => this.panes.paneTypeOf(leafId) === AGENT_PANE_TYPE && this.sessionOfPane(leafId) === sessionId);
    if (showing.includes(this.panes.focusedLeafId)) {
      return this.panes.focusedLeafId;
    }
    if (showing.length === 0) {
      return null;
    }
    return showing[0];
  }

  /** How the connection to the daemon is doing. Reactive. */
  state(): AgentsState {
    this.changes.track();
    return this.current;
  }

  /** Every session the daemon lists, whatever its directory. Reactive. */
  sessions(): readonly SessionInfo[] {
    this.changes.track();
    return this.sessionList;
  }

  /** The oldest question the daemon has asked this window for a secret in the session, or undefined. Reactive. */
  secretRequestFor(sessionId: string): SecretRequest | undefined {
    this.changes.track();
    return this.secretRequests.find((request) => request.session === sessionId);
  }

  /** Answers a secret question with what was typed, or with nothing when the user gave up. The value goes to the daemon and nowhere else. */
  answerSecret(id: string, value?: string): void {
    this.secretRequests = this.secretRequests.filter((request) => request.id !== id);
    this.changes.notify();
    if (this.client === null) {
      return;
    }
    try {
      this.client.answerSecret(id, value);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Every connector the daemon knows: apps, and the language servers and MCP servers it runs. Reactive. */
  connectors(): readonly ConnectorInfo[] {
    this.changes.track();
    return this.connectorList;
  }

  /** The sessions of the open repository grouped by worktree, the shown worktree first. Reactive. */
  groups(): SessionGroup[] {
    const selected = this.workspace.selectedWorktree();
    let selectedId: string | null = null;
    if (selected !== null) {
      selectedId = selected.id;
    }
    return groupSessions(this.sessions(), this.workspace.worktrees(), selectedId);
  }

  /** The sessions in the same worktree as this one, the tabs of its pane. Reactive. */
  siblingSessions(sessionId: string): SessionInfo[] {
    this.changes.track();
    return siblingsOf(this.groups(), sessionId).filter((info) => info.id === sessionId || !this.closedTabs.has(info.id));
  }

  /**
   * Takes a session's tab out of the strip; the session itself stays in the daemon and in the
   * Agents view, where opening it brings the tab back. A pane showing it moves to the next tab,
   * or to a new session when it was the last.
   */
  closeTab(leafId: string, sessionId: string): void {
    const tabs = this.siblingSessions(sessionId);
    this.closedTabs = new Set([...this.closedTabs, sessionId]);
    this.changes.notify();
    if (this.sessionOfPane(leafId) !== sessionId) {
      return;
    }
    const at = tabs.findIndex((tab) => tab.id === sessionId);
    let next = tabs[at + 1];
    if (next === undefined) {
      next = tabs[at - 1];
    }
    if (next === undefined) {
      void this.newSession();
      return;
    }
    this.showSession(leafId, next.id);
  }

  /** Puts a closed session's tab back, as opening it does. */
  private reopenTab(sessionId: string): void {
    if (!this.closedTabs.has(sessionId)) {
      return;
    }
    const reopened = new Set(this.closedTabs);
    reopened.delete(sessionId);
    this.closedTabs = reopened;
    this.changes.notify();
  }

  /** What the daemon says about a session, or undefined for one it does not list. Reactive. */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    return this.sessions().find((session) => session.id === sessionId);
  }

  /**
   * The session a review of a worktree's files goes to: the one whose agent touched one of the
   * files, else the one in the focused agent pane, else the one in the worktree that was active
   * last. Null when no session works in the worktree.
   */
  reviewSessionFor(worktreePath: string, paths: readonly string[]): string | null {
    const working = this.sessions().filter((info) => this.worktreePathOf(info.cwd) === worktreePath);
    for (const info of working) {
      if (this.touchedAny(info.id, paths)) {
        return info.id;
      }
    }
    const focusedLeaf = this.focusedAgentPane();
    if (focusedLeaf !== null) {
      const focusedSession = this.sessionOfPane(focusedLeaf);
      if (focusedSession !== null) {
        return focusedSession;
      }
    }
    if (working.length === 0) {
      return null;
    }
    const latest = [...working].sort((first, second) => second.lastActivity - first.lastActivity);
    return latest[0].id;
  }

  /** The root of the worktree a directory belongs to: the innermost one that holds it, or null when none does. */
  private worktreePathOf(directory: string): string | null {
    let found: string | null = null;
    for (const candidate of this.workspace.worktrees()) {
      const holds = isWithin(candidate.path, directory);
      if (holds && (found === null || candidate.path.length > found.length)) {
        found = candidate.path;
      }
    }
    return found;
  }

  /** Whether the session's agents changed one of the files, as far as the pane following it has heard. */
  private touchedAny(sessionId: string, paths: readonly string[]): boolean {
    const chat = this.chat(sessionId);
    if (chat === undefined) {
      return false;
    }
    const touched = chat.touches().touched;
    return paths.some((path) => touched.some((entry) => entry.path === path));
  }

  /**
   * Sends a session's agent a review: `text` is what the agent reads and `shown` what the chat
   * displays in its place. Rejects when the daemon is not connected or the session is unknown.
   */
  async sendReview(sessionId: string, text: string, shown: string): Promise<void> {
    const chat = this.chat(sessionId);
    if (chat !== undefined) {
      await chat.send(text, shown);
      return;
    }
    const client = this.client;
    if (client === null) {
      throw new Error("The agents are not connected.");
    }
    await client.input(sessionId, text, { shown } as Parameters<SuiteClient["input"]>[2]);
  }

  /** Whether the session is running a turn. Reactive. */
  isRunning(sessionId: string): boolean {
    const info = this.sessionInfo(sessionId);
    if (info === undefined) {
      return false;
    }
    return info.state === "running";
  }

  /** The session an agent pane shows, or null while it shows none. Reactive. */
  sessionOfPane(leafId: string): string | null {
    const sessionId = this.panes.paneState(leafId).sessionId;
    if (typeof sessionId !== "string") {
      return null;
    }
    return sessionId;
  }

  /** The agent pane that has the focus, or null while another kind of pane has it. Reactive. */
  focusedAgentPane(): string | null {
    const leafId = this.panes.focusedLeafId;
    if (this.panes.paneTypeOf(leafId) !== AGENT_PANE_TYPE) {
      return null;
    }
    return leafId;
  }

  /** The conversation the focused agent pane shows, or undefined when there is none. Reactive. */
  focusedChat(): ChatSession | undefined {
    const leafId = this.focusedAgentPane();
    if (leafId === null) {
      return undefined;
    }
    const sessionId = this.sessionOfPane(leafId);
    if (sessionId === null) {
      return undefined;
    }
    return this.chat(sessionId);
  }

  /** The conversation of the focused agent pane, else of the first agent pane there is, or undefined when no pane shows one. Reactive. */
  shownChat(): ChatSession | undefined {
    const focused = this.focusedChat();
    if (focused !== undefined) {
      return focused;
    }
    for (const leafId of this.panes.leafIds()) {
      if (this.panes.paneTypeOf(leafId) !== AGENT_PANE_TYPE) {
        continue;
      }
      const sessionId = this.sessionOfPane(leafId);
      if (sessionId === null) {
        continue;
      }
      const chat = this.chat(sessionId);
      if (chat !== undefined) {
        return chat;
      }
    }
    return undefined;
  }

  /** Whether a pane shows the session. Reactive. */
  isShown(sessionId: string): boolean {
    return this.panes
      .leafIds()
      .some((leafId) => this.panes.paneTypeOf(leafId) === AGENT_PANE_TYPE && this.sessionOfPane(leafId) === sessionId);
  }

  /** The title of an agent pane: its session's title, or "Agent" while it shows none. Reactive. */
  paneTitle(leafId: string): string {
    const sessionId = this.sessionOfPane(leafId);
    if (sessionId === null) {
      return "Agent";
    }
    const info = this.sessionInfo(sessionId);
    if (info === undefined) {
      return "Agent";
    }
    return sessionTitle(info);
  }

  /**
   * Connects to the daemon, starting it first when it is not running. Resolves once the attempt
   * is over: the state says whether the daemon is open or unavailable. Calling it again while it
   * is under way, or after it succeeded, waits for the same attempt.
   */
  ensureStarted(): Promise<void> {
    if (this.starting === null) {
      this.starting = this.connect();
    }
    return this.starting;
  }

  /** Tries again after the daemon was unavailable. */
  retry(): Promise<void> {
    this.retryDelayMs = 0;
    this.disconnect();
    this.starting = null;
    return this.ensureStarted();
  }

  /** The conversation of a session, or undefined while no pane follows it or the daemon is not connected. Reactive. */
  chat(sessionId: string): ChatSession | undefined {
    this.changes.track();
    const entry = this.followed.get(sessionId);
    if (entry === undefined || entry.chat === null) {
      return undefined;
    }
    return entry.chat;
  }

  /**
   * Starts following a session for a pane that shows it, connecting first when that has not
   * happened. Returns the call that lets go; the session is followed until every pane has.
   */
  follow(sessionId: string): () => void {
    let held = true;
    const entry = this.followed.get(sessionId);
    if (entry === undefined) {
      this.followed.set(sessionId, { chat: null, panes: 1 });
    } else {
      entry.panes += 1;
    }
    void this.ensureStarted().then(() => this.startChats());
    return () => {
      if (!held) {
        return;
      }
      held = false;
      this.stopFollowing(sessionId);
    };
  }

  /**
   * Starts a read-only chat of one agent's work in a session (a subagent or a guest), for the
   * agents list. Null while the daemon is not connected. The caller stops it.
   */
  openAgentChat(sessionId: string, agent: string): ChatSession | null {
    const client = this.client;
    if (client === null) {
      return null;
    }
    const chat = new ChatSession(client, sessionId, (source) => this.assetSource(source), {
      agent,
      openFile: (path) => this.openFile(path),
      openDiff: (path, texts) => this.openDiff(path, texts),
      directory: () => this.sessionInfo(sessionId)?.cwd,
    });
    chat.start();
    return chat;
  }

  /** Lets keys reach the view of a pane; returns the call that takes it back. */
  registerPane(leafId: string, handle: PaneHandle): () => void {
    this.paneHandles.set(leafId, handle);
    return () => {
      if (this.paneHandles.get(leafId) === handle) {
        this.paneHandles.delete(leafId);
      }
    };
  }

  /** The view of the focused agent pane, or undefined while another kind of pane has the focus. */
  focusedPane(): PaneHandle | undefined {
    const leafId = this.focusedAgentPane();
    if (leafId === null) {
      return undefined;
    }
    return this.paneHandles.get(leafId);
  }

  /** Shows the next session of the focused pane's worktree in it, or the previous one; the list wraps around. */
  stepSession(direction: 1 | -1): void {
    const leafId = this.focusedAgentPane();
    if (leafId === null) {
      return;
    }
    const current = this.sessionOfPane(leafId);
    if (current === null) {
      return;
    }
    const tabs = this.siblingSessions(current);
    const at = tabs.findIndex((tab) => tab.id === current);
    if (at < 0 || tabs.length < 2) {
      return;
    }
    const next = tabs[(at + direction + tabs.length) % tabs.length];
    this.showSession(leafId, next.id);
  }

  /** Makes one pane show another session, the way a tab does. */
  showSession(leafId: string, sessionId: string): void {
    this.reopenTab(sessionId);
    this.panes.setPaneState(leafId, { sessionId });
  }

  /**
   * Shows a session in a pane: the pane that already shows it, else the focused agent pane, else
   * the first agent pane, else a new pane split off the focused one.
   */
  openSession(sessionId: string): void {
    this.reopenTab(sessionId);
    const paneIds = this.panes.leafIds().filter((leafId) => this.panes.paneTypeOf(leafId) === AGENT_PANE_TYPE);
    const showing = paneIds.find((leafId) => this.sessionOfPane(leafId) === sessionId);
    if (showing !== undefined) {
      this.panes.focus(showing);
      return;
    }
    const focused = this.panes.focusedLeafId;
    if (paneIds.includes(focused)) {
      this.panes.setPaneState(focused, { sessionId });
      return;
    }
    if (paneIds.length > 0) {
      this.panes.setPaneState(paneIds[0], { sessionId });
      this.panes.focus(paneIds[0]);
      return;
    }
    this.panes.splitFocused("row", AGENT_PANE_TYPE);
    this.panes.setPaneState(this.panes.focusedLeafId, { sessionId });
  }

  /**
   * Starts a session in the shown worktree and opens it in a pane. Resolves to the session's id,
   * or null when the daemon could not be reached or refused.
   */
  async newSession(): Promise<string | null> {
    await this.ensureStarted();
    const client = this.client;
    if (client === null) {
      return null;
    }
    try {
      const created = await client.createSession({ cwd: this.newSessionDirectory() });
      this.openSession(created.id);
      return created.id;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** Where a new session works: the shown worktree, else the daemon's own default. */
  private newSessionDirectory(): string | undefined {
    const selected = this.workspace.selectedWorktree();
    if (selected === null) {
      return undefined;
    }
    return selected.path;
  }

  /** Makes a split of an agent pane show the same session as the pane it came from. */
  private paneSplit(newLeafId: string, sourceLeafId: string): void {
    if (this.panes.paneTypeOf(newLeafId) !== AGENT_PANE_TYPE) {
      return;
    }
    if (this.panes.paneTypeOf(sourceLeafId) !== AGENT_PANE_TYPE) {
      return;
    }
    const sessionId = this.sessionOfPane(sourceLeafId);
    if (sessionId === null) {
      return;
    }
    this.panes.setPaneState(newLeafId, { sessionId });
  }

  /**
   * Finds the daemon, starts it when needed, and connects, within the connect timeout. Every
   * failure ends as the state; a daemon that is alive but does not answer ends as one too.
   */
  private async connect(): Promise<void> {
    this.attempt += 1;
    const attempt = this.attempt;
    this.setState({ connection: "starting" });
    try {
      await withDeadline(this.open(attempt), this.timing.connectTimeoutMs, "The suite daemon did not answer");
    } catch (error) {
      this.giveUp(error, this.retryDelayMs > 0);
    }
  }

  /** The steps of one connection attempt; an attempt that was given up on closes its client instead of adopting it. */
  private async open(attempt: number): Promise<void> {
    await this.reachDaemon();
    this.setState({ connection: "connecting" });
    const client = await this.host.connect({
      client: CLIENT_NAME,
      address: () => this.readAddress(),
      requestTimeoutMs: this.timing.requestTimeoutMs,
      onError: (error) => this.fail(error),
    });
    if (attempt !== this.attempt) {
      void client.close().catch(() => {});
      return;
    }
    await this.adopt(client, attempt);
  }

  /**
   * Closes whatever connection there is and shows the daemon as unavailable, saying why. A
   * connection that was lost, and the attempts to get it back, are tried again by themselves, with
   * longer waits in between; one that never came up waits for the user to press Try again.
   */
  private giveUp(error: unknown, retryAutomatically = false): void {
    this.attempt += 1;
    this.disconnect();
    const state: AgentsState = { connection: "unavailable", message: describeError(error) };
    if (retryAutomatically) {
      state.retryAt = Date.now() + this.scheduleRetry();
    }
    this.setState(state);
  }

  /** Starts the wait before the next automatic attempt, and returns how long it is. */
  private scheduleRetry(): number {
    this.retryDelayMs = nextRetryDelay(this.retryDelayMs, this.timing.retryInitialMs, this.timing.retryMaxMs);
    const delay = this.retryDelayMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.starting = this.connect();
    }, delay);
    return delay;
  }

  /** Stops waiting to try again, as when the user did, or the service is going away. */
  private clearRetryTimer(): void {
    if (this.retryTimer === null) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Makes sure a daemon is running: its address is readable, or `suite up` starts it. */
  private async reachDaemon(): Promise<void> {
    try {
      await this.readAddress();
      return;
    } catch (error) {
      if (!isNotRunning(error)) {
        throw error;
      }
    }
    await this.host.startDaemon();
    await this.readAddress();
  }

  /** Reads the daemon's address afresh, and remembers it for the URLs of its pictures. */
  private async readAddress(): Promise<DaemonAddress> {
    const address = await this.host.address();
    this.address = address;
    return address;
  }

  /** Takes a connected client: follows its state and session list and registers this window. */
  private async adopt(client: SuiteClient, attempt: number): Promise<void> {
    this.client = client;
    this.retryDelayMs = 0;
    this.sessionList = client.sessions.value;
    this.setState({ connection: connectionOf(client.state.value) });
    client.state.on((state) => this.connectionChanged(client, attempt, state));
    client.focus.on((focus) => this.focusChanged(focus));
    client.sessions.on((sessions) => {
      this.sessionList = sessions;
      this.changes.notify();
    });
    this.stopSecrets = client.onSecretRequest((request) => {
      this.secretRequests = [...this.secretRequests.filter((known) => known.id !== request.id), request];
      this.changes.notify();
    });
    this.connectorList = client.connectors.value;
    client.connectors.on((connectors) => {
      this.connectorList = connectors;
      this.changes.notify();
    });
    this.sessionList = await client.listSessions();
    this.changes.notify();
    await this.register(client);
    this.startChats();
  }

  /**
   * Follows the client's connection. A connection that drops is retried by the client without
   * end, so the service gives up on it when it has been down for the reconnect timeout.
   */
  private connectionChanged(client: SuiteClient, attempt: number, state: ConnectionState): void {
    if (attempt !== this.attempt || client !== this.client) {
      return;
    }
    this.clearReconnectTimer();
    this.setState({ connection: connectionOf(state) });
    if (state !== "reconnecting") {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryDelayMs = 0;
      this.giveUp(new Error("The suite daemon stopped answering"), true);
    }, this.timing.reconnectTimeoutMs);
  }

  /** Stops waiting for a dropped connection to come back. */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Tells the daemon about this window under a name no other window of Grove has taken. */
  private async register(client: SuiteClient): Promise<void> {
    try {
      const connectors = await client.listConnectors();
      this.appName = freeAppName(connectors);
      await client.setPresence(await this.presence());
      this.registered = true;
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * The presence of this window. Components and tools are keyed by the app id, so only the
   * window that holds the plain `grove` id offers them: the agent always writes `grove.<Name>`.
   */
  private async presence(): Promise<AppPresence> {
    const presence: AppPresence = {
      app: this.appName,
      kind: "app",
      title: "Grove",
      open: true,
      context: this.presenceContext(),
    };
    if (this.appName !== CLIENT_NAME) {
      return presence;
    }
    const components = this.components.all();
    if (Object.keys(components).length > 0) {
      presence.components = components;
    }
    const tools = this.tools.values();
    if (tools.length > 0 || this.toolsServed) {
      await this.serveTools(presence, tools);
    }
    return presence;
  }

  /** Has the host list the tools and puts the endpoint in the presence; a host that cannot leaves the window without tools. */
  private async serveTools(presence: AppPresence, tools: AppTool[]): Promise<void> {
    try {
      presence.mcp = await this.host.toolServer().serve(tools);
      this.toolsServed = true;
    } catch (error) {
      this.fail(error);
    }
  }

  /** Sends the presence again after the components or tools changed, when the daemon knows this window. */
  private async resendPresence(): Promise<void> {
    const client = this.client;
    if (client === null || !this.registered) {
      return;
    }
    try {
      await client.setPresence(await this.presence());
    } catch (error) {
      this.fail(error);
    }
  }

  /** Tells the daemon what this window shows now, after another worktree was selected. */
  private async updateContext(): Promise<void> {
    const client = this.client;
    if (client === null || !this.registered) {
      return;
    }
    try {
      await client.setContext(this.presenceContext());
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Tells the daemon an agent pane of this window shows a session: the agent moves here, and the
   * session becomes the current one for every client. Does nothing when the daemon already has
   * the agent in this window on that session, and when the daemon is not connected.
   */
  async showing(sessionId: string): Promise<void> {
    await this.ensureStarted();
    const client = this.client;
    if (client === null || !this.registered) {
      return;
    }
    this.shownSession = sessionId;
    const focus = client.focus.value;
    if (focus !== undefined && focus.app === this.appName && focus.session === sessionId) {
      return;
    }
    this.movingTo = sessionId;
    try {
      await client.moveAgent({ app: this.appName, session: sessionId });
    } catch (error) {
      this.movingTo = null;
      this.fail(error);
    }
  }

  /**
   * The agent moved: when it is in this window on a session no pane shows (`/clear` started a
   * new conversation, or `suite move` chose one), the pane that showed the last one shows it.
   * Moves that were before the one this window asked for are not news, and neither are the
   * daemon's own settling moves (its first word after connecting, the agent finding an app
   * open), which must not take over a pane the user left on another session.
   */
  private focusChanged(focus: AgentFocus | undefined): void {
    if (focus === undefined || focus.app !== this.appName || this.shownSession === null) {
      return;
    }
    if (focus.reason === "initial" || focus.reason === "opened" || focus.reason === "closed") {
      return;
    }
    if (this.movingTo !== null) {
      if (focus.session === this.movingTo) {
        this.movingTo = null;
      }
      return;
    }
    if (focus.session === this.shownSession || this.isShown(focus.session)) {
      return;
    }
    this.followAgentTo(focus.session);
  }

  /** Shows a session in the pane that showed the one before, else the focused agent pane, else the first. */
  private followAgentTo(sessionId: string): void {
    const paneIds = this.panes.leafIds().filter((leafId) => this.panes.paneTypeOf(leafId) === AGENT_PANE_TYPE);
    let target = paneIds.find((leafId) => this.sessionOfPane(leafId) === this.shownSession);
    if (target === undefined && paneIds.includes(this.panes.focusedLeafId)) {
      target = this.panes.focusedLeafId;
    }
    if (target === undefined) {
      target = paneIds[0];
    }
    if (target === undefined) {
      return;
    }
    this.shownSession = sessionId;
    this.panes.setPaneState(target, { sessionId });
  }

  /** What the agent is told this window shows: the shown worktree's directory. */
  private presenceContext(): Record<string, string> {
    const selected = this.workspace.selectedWorktree();
    if (selected === null) {
      return {};
    }
    return { cwd: selected.path };
  }

  /** Gives every session a pane shows its chat, once there is a client to follow it with. */
  private startChats(): void {
    const client = this.client;
    if (client === null) {
      return;
    }
    for (const [sessionId, entry] of this.followed) {
      if (entry.chat !== null) {
        continue;
      }
      entry.chat = new ChatSession(client, sessionId, (source) => this.assetSource(source), {
        openFile: (path) => this.openFile(path),
        openDiff: (path, texts) => this.openDiff(path, texts),
        showEditQuestion: (question) => this.showEditQuestion(sessionId, question),
        directory: () => this.sessionInfo(sessionId)?.cwd,
        waiting: () => this.sessionInfo(sessionId)?.waiting,
        listFiles: (directory) => this.openers.listFiles(directory),
      });
      entry.chat.start();
    }
    this.changes.notify();
  }

  /** Counts a pane off a session and stops following it with the last. */
  private stopFollowing(sessionId: string): void {
    const entry = this.followed.get(sessionId);
    if (entry === undefined) {
      return;
    }
    entry.panes -= 1;
    if (entry.panes > 0) {
      return;
    }
    if (entry.chat !== null) {
      entry.chat.stop();
    }
    this.followed.delete(sessionId);
    this.changes.notify();
  }

  /** The URL the daemon serves an asset handle from, which holds its token, or undefined for any other source. */
  private assetSource(source: string): string | undefined {
    if (this.address === null) {
      return undefined;
    }
    return this.host.assetUrl(this.address, source);
  }

  /** Closes the connection and stops every chat; the plugin's unloading does this. */
  private disconnect(): void {
    this.clearReconnectTimer();
    this.clearRetryTimer();
    this.registered = false;
    this.movingTo = null;
    // The daemon drops a question when its client goes, so none is kept for the next connection.
    this.stopSecrets?.();
    this.stopSecrets = null;
    this.secretRequests = [];
    for (const entry of this.followed.values()) {
      if (entry.chat !== null) {
        entry.chat.stop();
        entry.chat = null;
      }
    }
    const client = this.client;
    this.client = null;
    if (client !== null) {
      void client.close().catch(() => {});
    }
  }

  /** Records a new state and redraws what reads it. */
  private setState(next: AgentsState): void {
    this.current = next;
    this.changes.notify();
  }

  /** Keeps the message of a failure nobody was waiting for, without changing the connection. */
  private fail(error: unknown): void {
    this.setState({ ...this.current, message: describeError(error) });
  }
}

/** Resolves with the promise's result, or rejects with `message` when it takes longer than `timeoutMs`. */
function withDeadline<Result>(promise: Promise<Result>, timeoutMs: number, message: string): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The service's connection word for the client's. */
function connectionOf(state: "connecting" | "open" | "reconnecting" | "closed"): AgentsState["connection"] {
  if (state === "closed") {
    return "unavailable";
  }
  return state;
}

/** `grove`, or `grove-2` and on when another window of Grove is already connected under the name. */
export function freeAppName(connectors: readonly ConnectorInfo[]): string {
  const taken = (name: string): boolean => connectors.some((connector) => connector.app === name && connector.connected);
  if (!taken(CLIENT_NAME)) {
    return CLIENT_NAME;
  }
  let number = 2;
  while (taken(`${CLIENT_NAME}-${number}`)) {
    number += 1;
  }
  return `${CLIENT_NAME}-${number}`;
}

/** Whether a failure says the daemon is not running, as the host's `suite_address` does. */
function isNotRunning(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (error as Error & { code?: string }).code === "NotRunning";
}

/** An error as the sentence to show for it. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
