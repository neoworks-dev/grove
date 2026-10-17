// What a session's events say beyond its chat: whether it runs and with which approvals, the
// plans of its agents, the files they touched and the subagents working for it. One fold over the
// event log, which the daemon replays from the start whenever a session is followed.

import type { SessionEventRecord } from "@suite/protocol/types";
import { applyCall, noCalls, type Calls } from "./calls";
import { NO_TOUCHES, applyTouch, type Touches } from "./files";
import { applyPlan, type PlanList } from "./plan";
import { applyStatusEvent, initialStatus, type SessionStatus } from "./status";
import { applyAgentEvent, type AgentRow } from "./subagents";

export class SessionFacts {
  status: SessionStatus = initialStatus();
  plans: readonly PlanList[] = [];
  touches: Touches = NO_TOUCHES;
  agents: readonly AgentRow[] = [];
  calls: Calls = noCalls();
  private lastSeq = 0;

  /**
   * Folds one more event in. An event that is not after the last one means the log is being
   * replayed, so the fold starts over. Returns whether anything it keeps changed.
   */
  apply(record: SessionEventRecord): boolean {
    const before = [this.status, this.plans, this.touches, this.agents, this.calls];
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
    const after = [this.status, this.plans, this.touches, this.agents, this.calls];
    return before.some((value, index) => value !== after[index]);
  }

  /** Forgets everything, as when the log starts over. */
  reset(): void {
    this.status = initialStatus();
    this.plans = [];
    this.touches = NO_TOUCHES;
    this.agents = [];
    this.calls = noCalls();
    this.lastSeq = 0;
  }
}
