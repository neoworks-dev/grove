// What a session's events say beyond its chat: whether it runs and with which approvals, the
// plans of its agents, the files they touched and the subagents working for it. One fold over the
// event log, which the daemon replays from the start whenever a session is followed.

import type { SessionEventRecord, TodoItem } from "@suite/protocol/types";
import { applyBackground, noBackground, type Background } from "./background";
import { applyCall, noCalls, type Calls } from "./calls";
import { applyEditQuestion, type EditQuestions } from "./editQuestions";
import { NO_TOUCHES, applyTouch, type Touches } from "./files";
import { applyPlan, type PlanList } from "./plan";
import { applyStatusEvent, initialStatus, type SessionStatus } from "./status";
import type { OfferedCommand } from "./slashCommands";
import { applyAgentEvent, type AgentRow } from "./subagents";

export class SessionFacts {
  status: SessionStatus = initialStatus();
  plans: readonly PlanList[] = [];
  touches: Touches = NO_TOUCHES;
  agents: readonly AgentRow[] = [];
  calls: Calls = noCalls();
  /** The refs of the chat notices that announce a setting change (`n<seq>`, as the daemon names them). */
  settingNotices: ReadonlySet<string> = new Set();
  /** The slash commands each harness listed (`commands_available`), by harness name; the latest listing replaces the earlier. */
  harnessCommands: ReadonlyMap<string, readonly OfferedCommand[]> = new Map();
  /** The shared todo list, as the newest `todos` event left it. */
  todos: readonly TodoItem[] = [];
  /** The commands the agents ran, and the ones that went to the background. */
  background: Background = noBackground();
  /** The edits the agent asks about that wait for an answer, by request id. */
  editQuestions: EditQuestions = new Map();
  private lastSeq = 0;

  /**
   * Folds one more event in. An event that is not after the last one means the log is being
   * replayed, so the fold starts over. Returns whether anything it keeps changed.
   */
  apply(record: SessionEventRecord): boolean {
    const before = [this.status, this.plans, this.touches, this.agents, this.calls, this.settingNotices, this.harnessCommands, this.todos, this.background, this.editQuestions];
    if (record.seq <= this.lastSeq) {
      this.reset();
    }
    this.lastSeq = record.seq;
    this.status = applyStatusEvent(this.status, record);
    if (record.event.type === "plan") {
      this.plans = applyPlan(this.plans, record.event);
    }
    this.touches = applyTouch(this.touches, record);
    this.agents = applyAgentEvent(this.agents, record);
    this.calls = applyCall(this.calls, record);
    if (record.event.type === "setting_changed") {
      this.settingNotices = new Set([...this.settingNotices, `n${record.seq}`]);
    }
    if (record.event.type === "commands_available") {
      this.harnessCommands = new Map(this.harnessCommands).set(record.event.harness, record.event.commands);
    }
    this.background = applyBackground(this.background, record);
    this.editQuestions = applyEditQuestion(this.editQuestions, record);
    if (record.event.type === "todos") {
      this.todos = record.event.items;
    }
    const after = [this.status, this.plans, this.touches, this.agents, this.calls, this.settingNotices, this.harnessCommands, this.todos, this.background, this.editQuestions];
    return before.some((value, index) => value !== after[index]);
  }

  /** Forgets everything, as when the log starts over. */
  reset(): void {
    this.status = initialStatus();
    this.plans = [];
    this.touches = NO_TOUCHES;
    this.agents = [];
    this.calls = noCalls();
    this.settingNotices = new Set();
    this.harnessCommands = new Map();
    this.todos = [];
    this.background = noBackground();
    this.editQuestions = new Map();
    this.lastSeq = 0;
  }
}
