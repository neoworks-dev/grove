// What the row of controls under the composer says: the harness, how much the agent may do
// without asking, how full the context is and what it costs, and the model and effort. Plain
// functions, so they are tested without a window. The row is Grove's original composer footer.

import { contextPercent, formatCost } from "./composerStatus";
import { APPROVALS, currentSettings, type Approvals, type SessionStatus } from "./status";
import { tokensLabel } from "./chat/workingPhrases";

/** One choice of the approvals dropdown. */
export interface ApprovalsChoice {
  value: Approvals;
  label: string;
}

/** What each approvals mode asks the user, said where the mode is chosen. */
const APPROVALS_LABELS: Record<Approvals, string> = {
  ask: "Ask",
  review: "Review",
  edits: "Edits",
  auto: "Auto",
};

/** The approvals modes as the dropdown lists them. */
export function approvalsChoices(): ApprovalsChoice[] {
  return APPROVALS.map((value) => ({ value, label: APPROVALS_LABELS[value] }));
}

/** The line that names the mode in force: `Ask mode`. */
export function modeLine(approvals: Approvals): string {
  return `${APPROVALS_LABELS[approvals]} mode`;
}

/** The tokens, the share of the context and the cost, as `32.0k · 16% · $0.05`; the parts that are known. */
export function usageLine(status: SessionStatus): string {
  const parts: string[] = [];
  const tokens = tokensLabel(status.usage?.contextUsed);
  if (tokens !== undefined) {
    parts.push(tokens);
  }
  const percent = contextPercent(status.usage);
  if (percent !== undefined) {
    parts.push(`${percent}%`);
  }
  const cost = formatCost(status.usage?.cost);
  if (cost !== undefined) {
    parts.push(cost);
  }
  return parts.join(" · ");
}

/** The model and effort the session runs with, as `claude-sonnet-4 · high`; the parts that are set. */
export function modelLine(status: SessionStatus): string {
  const settings = currentSettings(status);
  const parts: string[] = [];
  if (settings.model !== undefined) {
    parts.push(settings.model);
  }
  if (settings.effort !== undefined) {
    parts.push(settings.effort);
  }
  return parts.join(" · ");
}
