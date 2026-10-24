// What the composer's controls say: the harness, its model and effort, how much the agent may do
// without asking, and how full the context is and what it costs. Plain functions, so they are
// tested without a window.

import type { ConfigCategory, ConfigOption, HarnessSettings as OfferedHarness } from "@suite/protocol/types";
import eye from "@phosphor-icons/core/regular/eye.svg";
import handPalm from "@phosphor-icons/core/regular/hand-palm.svg";
import lightning from "@phosphor-icons/core/regular/lightning.svg";
import pencil from "@phosphor-icons/core/regular/pencil-simple.svg";
import { harnessMark } from "./harnessMarks";
import { contextPercent, formatCost } from "./composerStatus";
import { APPROVALS, type Approvals, type SessionStatus } from "./status";
import { tokensLabel } from "./chat/workingPhrases";

/** One choice of the approvals dropdown. */
export interface ApprovalsChoice {
  value: Approvals;
  label: string;
  /** SVG markup drawn in front of the label in the list. */
  icon: string;
}

/** An icon for each approvals mode: a raised hand asks, an eye reviews, a pencil edits, a bolt runs on its own. */
const APPROVALS_ICONS: Record<Approvals, string> = {
  ask: handPalm,
  review: eye,
  edits: pencil,
  auto: lightning,
};

/** The icon that stands for an approvals mode, in the dropdown and on its button. */
export function approvalsIcon(approvals: Approvals): string {
  return APPROVALS_ICONS[approvals];
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
  return APPROVALS.map((value) => ({ value, label: APPROVALS_LABELS[value], icon: APPROVALS_ICONS[value] }));
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

/** One choice of a dropdown in the composer. */
export interface Choice {
  value: string;
  label: string;
  /** SVG markup drawn in front of the label in the list. */
  icon?: string;
}

/** The text with its first letter in upper case: `claude` as `Claude`. */
export function capitalize(text: string): string {
  if (text === "") {
    return text;
  }
  return text[0].toUpperCase() + text.slice(1);
}

/** The harnesses the session can switch to, by their titles; the current one alone until the daemon says. */
export function harnessChoices(offered: readonly OfferedHarness[], current: string): Choice[] {
  if (offered.length === 0) {
    return [{ value: current, label: capitalize(current), icon: harnessMark(current).svg }];
  }
  return offered.map((harness) => ({ value: harness.name, label: capitalize(harness.title), icon: harnessMark(harness.name).svg }));
}

/** A harness's title as the daemon gives it, else its name capitalized. */
export function harnessLabel(offered: readonly OfferedHarness[], name: string): string {
  const harness = offered.find((entry) => entry.name === name);
  if (harness === undefined) {
    return capitalize(name);
  }
  return capitalize(harness.title);
}

/** The values a harness offers for one of its options, by their names. */
export function optionChoices(offered: readonly OfferedHarness[], harness: string, category: ConfigCategory): Choice[] {
  const option = offeredOption(offered, harness, category);
  if (option === undefined) {
    return [];
  }
  return option.values.map((value) => ({ value: value.value, label: capitalize(value.name) }));
}

/**
 * What an option of the harness is set to, by the name the harness gives it (`Haiku 4.5`, not
 * `haiku`): the value the session set, else the harness's own current one, else undefined.
 */
export function optionLabel(
  offered: readonly OfferedHarness[],
  harness: string,
  category: ConfigCategory,
  chosen: string | undefined,
): string | undefined {
  const option = offeredOption(offered, harness, category);
  let value = chosen;
  if (value === undefined && option !== undefined) {
    value = option.current;
  }
  if (value === undefined) {
    return undefined;
  }
  const named = option?.values.find((entry) => entry.value === value);
  if (named === undefined) {
    return capitalize(value);
  }
  return capitalize(named.name);
}

/** One option a harness offers, or undefined when it offers none of that kind. */
function offeredOption(offered: readonly OfferedHarness[], harness: string, category: ConfigCategory): ConfigOption | undefined {
  const entry = offered.find((candidate) => candidate.name === harness);
  if (entry === undefined) {
    return undefined;
  }
  return entry.options.find((option) => option.category === category);
}
