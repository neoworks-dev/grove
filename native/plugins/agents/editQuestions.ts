// The edits the agent asks about: in ask mode before it writes them, in review mode after, to keep
// or revert. They come as `permission_request` events whose content is the whole old and new text
// of each file, which the chat's items cut to a few lines. The editor shows those texts as a diff
// while the question waits. Plain functions, so they are tested without a window.

import type { SessionEventRecord } from "@suite/protocol/types";
import { diffsOf, type CallDiff } from "./calls";
import type { Prompt } from "./prompt";

/** An edit the agent asks about. */
export interface EditQuestion {
  /** The permission request's id, which its buttons answer with. */
  id: string;
  /** True when the edit is on disk already and the question is whether to keep it (review mode). */
  written: boolean;
  diffs: readonly CallDiff[];
}

/** The edit questions of a session by their id. */
export type EditQuestions = ReadonlyMap<string, EditQuestion>;

/** The option id the daemon gives Revert, which only a question about a written edit offers. */
const REVERT_OPTION = "revert";

/**
 * The questions after one more event: a `permission_request` with a diff adds one, and its
 * `permission_resolved` takes it away. The map is new only when the event changed it.
 */
export function applyEditQuestion(questions: EditQuestions, record: SessionEventRecord): EditQuestions {
  const { event } = record;
  if (event.type === "permission_resolved") {
    if (!questions.has(event.id)) {
      return questions;
    }
    const rest = new Map(questions);
    rest.delete(event.id);
    return rest;
  }
  if (event.type !== "permission_request" || event.content === undefined) {
    return questions;
  }
  const diffs = diffsOf(event.content);
  if (diffs.length === 0) {
    return questions;
  }
  const written = event.options.some((option) => option.id === REVERT_OPTION);
  return new Map(questions).set(event.id, { id: event.id, written, diffs });
}

/** The edit a prompt asks about, found by the request id its buttons answer with, or undefined for any other prompt. */
export function editQuestionOf(prompt: Prompt | undefined, questions: EditQuestions): EditQuestion | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  for (const button of prompt.buttons) {
    const id = requestIdOf(button.args);
    if (id === undefined) {
      continue;
    }
    const question = questions.get(id);
    if (question !== undefined) {
      return question;
    }
  }
  return undefined;
}

/** The `id` a permission button's args carry. */
function requestIdOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const id = (args as Record<string, unknown>).id;
  if (typeof id !== "string") {
    return undefined;
  }
  return id;
}
