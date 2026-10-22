// How the chat is laid out in rows. Each user message opens a section. Once the agent has
// answered and gone quiet, the section folds: the calls that went well and the messages before
// the answer shrink into one summary line, the files the turn changed stay as rows, and what still
// wants a reader (the answer, a failed call, a question, a notice) stays as it is. Opening the
// summary shows the section's items again, with runs of settled calls shrunk to one line each.
// Plain functions, so they are tested without a window. Ported from Grove's own agent pane
// (lib/agents/turns.ts, toolRuns.ts and changedFiles.ts).

import type { Component, DiffComponent, ViewItem } from "@suite/protocol/types";
import type { CallFacts } from "../calls";
import { baseName, hasDoc } from "./components";
import { diffStats } from "./diff";

/** One tool and how many times a run called it. */
export interface Tally {
  name: string;
  count: number;
  /** The file names its calls were about, once each, in the order they came. */
  files: string[];
}

/** A file a turn changed, once, with the lines of all its changes counted. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /** The turn's first change to the file created it. */
  created: boolean;
}

export type ChatRow =
  | { kind: "item"; key: string; item: ViewItem }
  /** The line a folded turn is reduced to. */
  | { kind: "turn"; key: string; foldKey: string; open: boolean; tallies: Tally[]; messages: number; steps: number }
  /** What a folded turn changed. */
  | { kind: "files"; key: string; files: ChangedFile[] }
  /** Calls that went well, folded to a line. */
  | { kind: "run"; key: string; foldKey: string; open: boolean; tallies: Tally[]; items: ViewItem[] }
  /** The bar that says a turn is in flight, below everything else. */
  | { kind: "working"; key: string };

/** What the layout needs to know about the session. */
export interface ChatFacts {
  /** Whether turns fold; an agent's own chat is shown as it happened, since it has no events to fold by. */
  fold: boolean;
  /** The calls' own facts by item ref, as the events told them. */
  callOf: (ref: string) => CallFacts | undefined;
  /** Whether a turn is running now. */
  running: boolean;
  /** Whether the user opened the turn or run with this key. */
  isOpen: (key: string) => boolean;
}

/** Below this a run says no more than the calls themselves. */
const MIN_RUN = 2;

/** A section: what one user message started. */
interface Section {
  key: string;
  header: ViewItem | undefined;
  body: ViewItem[];
}

/** Splits the items at each user message; whatever comes before the first forms a headerless lead. */
export function sectionsOf(items: readonly ViewItem[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { key: "lead", header: undefined, body: [] };
  for (const item of items) {
    if (item.kind !== "user") {
      current.body.push(item);
      continue;
    }
    if (current.header !== undefined || current.body.length > 0) {
      sections.push(current);
    }
    current = { key: item.ref, header: item, body: [] };
  }
  if (current.header !== undefined || current.body.length > 0) {
    sections.push(current);
  }
  return sections;
}

/** What the daemon says when an app connects, comes back, updates or goes, and when the agent moves between apps. */
const APP_NOTICE = /^(now in \S+|\S+ connected \(v\d+\)|\S+ is back \(v\d+\)|\S+ updated \(v\d+\)|\S+ disconnected)/;

/** Whether an item is one of those notices, which say nothing a reader of the chat needs: the panes are the apps. */
export function isAppNotice(item: ViewItem): boolean {
  if (item.kind !== "notice" || item.component.type !== "text") {
    return false;
  }
  const first = item.component.blocks[0];
  if (first === undefined || first.type !== "paragraph") {
    return false;
  }
  return APP_NOTICE.test(first.spans.map((span) => span.text).join(""));
}

/** The rows of the whole chat, in order. */
export function chatRows(shown: readonly ViewItem[], facts: ChatFacts): ChatRow[] {
  const rows: ChatRow[] = [];
  if (!facts.fold) {
    pushItems(rows, shown);
    return rows;
  }
  const items = shown.filter((item) => !isAppNotice(item));
  const sections = sectionsOf(items);
  sections.forEach((section, index) => {
    const inFlight = facts.running && index === sections.length - 1;
    if (section.header !== undefined) {
      rows.push({ kind: "item", key: section.header.ref, item: section.header });
    }
    if (inFlight) {
      pushItems(rows, section.body);
      return;
    }
    pushSettled(rows, section, facts);
  });
  if (facts.running) {
    rows.push({ kind: "working", key: "working" });
  }
  return rows;
}

/** The rows of a section whose turn is over. */
function pushSettled(rows: ChatRow[], section: Section, facts: ChatFacts): void {
  const fold = foldTurn(section.body, facts.callOf);
  if (fold.hidden.length === 0) {
    pushRuns(rows, section.body, facts);
    return;
  }
  const open = facts.isOpen(section.key);
  const tallies = talliesOf(fold.hidden, facts.callOf);
  const messages = fold.hidden.filter((item) => item.kind === "agent").length;
  rows.push({ kind: "turn", key: `turn:${section.key}`, foldKey: section.key, open, tallies, messages, steps: fold.hidden.length });
  if (open) {
    pushRuns(rows, section.body, facts);
    return;
  }
  const files = changedFilesOf(fold.hidden, facts.callOf);
  if (files.length > 0) {
    rows.push({ kind: "files", key: `files:${section.key}`, files });
  }
  pushItems(rows, fold.kept);
}

/** Every item as a row of its own. */
function pushItems(rows: ChatRow[], items: readonly ViewItem[]): void {
  for (const item of items) {
    rows.push({ kind: "item", key: item.ref, item });
  }
}

/** The items as rows, with each run of settled calls folded into a row. */
function pushRuns(rows: ChatRow[], items: readonly ViewItem[], facts: ChatFacts): void {
  let run: ViewItem[] = [];
  const flush = (): void => {
    if (run.length >= MIN_RUN) {
      const key = `run:${run[0].ref}`;
      rows.push({ kind: "run", key, foldKey: key, open: facts.isOpen(key), tallies: talliesOf(run, facts.callOf), items: run });
    } else {
      pushItems(rows, run);
    }
    run = [];
  };
  for (const item of items) {
    if (isFoldableCall(item, facts.callOf)) {
      run.push(item);
      continue;
    }
    flush();
    rows.push({ kind: "item", key: item.ref, item });
  }
  flush();
}

/** A call that finished well and changed no file: the kind that disappears into a summary. */
function isFoldableCall(item: ViewItem, callOf: (ref: string) => CallFacts | undefined): boolean {
  if (item.kind !== "tool" || item.state !== "done" || hasDoc(item.component)) {
    return false;
  }
  const call = callOf(item.ref);
  return call !== undefined && call.diffs.length === 0;
}

/** Whether an item is the turn working rather than talking; a call that drew a neoui doc is not, since the doc is what it is for. */
function isWork(item: ViewItem, callOf: (ref: string) => CallFacts | undefined): boolean {
  if (item.kind === "agent" || item.kind === "thought") {
    return true;
  }
  if (item.kind !== "tool" || item.state !== "done" || hasDoc(item.component)) {
    return false;
  }
  return isPlan(item) || callOf(item.ref) !== undefined;
}

/** The item the daemon keeps a plan in; the plan has its own place beside the chat, so a folded turn hides it. */
function isPlan(item: ViewItem): boolean {
  return item.ref === "plan" || item.ref.startsWith("plan-");
}

export interface TurnFold {
  /** The work leading to the answer, hidden while the turn is folded. */
  hidden: ViewItem[];
  /** The answer and anything that still wants a reader. */
  kept: ViewItem[];
}

/**
 * Splits a settled turn's items into the ones a folded turn hides and the ones it keeps. The
 * answer is the agent's last message, with the messages directly before it that no settled call
 * stands between. A turn without an answer folds nothing, since nothing would be left to read.
 */
export function foldTurn(body: readonly ViewItem[], callOf: (ref: string) => CallFacts | undefined): TurnFold {
  let lastAnswer = -1;
  body.forEach((item, index) => {
    if (item.kind === "agent") {
      lastAnswer = index;
    }
  });
  if (lastAnswer < 0) {
    return { hidden: [], kept: [...body] };
  }
  const answer = answerIndexes(body, lastAnswer, callOf);
  const hidden: ViewItem[] = [];
  const kept: ViewItem[] = [];
  body.forEach((item, index) => {
    if (!answer.has(index) && isWork(item, callOf)) {
      hidden.push(item);
      return;
    }
    kept.push(item);
  });
  return { hidden, kept };
}

/** The indexes of the messages that make up the answer ending at `lastAnswer`. */
function answerIndexes(body: readonly ViewItem[], lastAnswer: number, callOf: (ref: string) => CallFacts | undefined): Set<number> {
  const answer = new Set([lastAnswer]);
  for (let index = lastAnswer - 1; index >= 0; index -= 1) {
    const item = body[index];
    if (item.kind === "agent") {
      answer.add(index);
      continue;
    }
    if (item.kind === "tool" && isWork(item, callOf)) {
      break;
    }
  }
  return answer;
}

/** The word a call goes by in a summary: the tool's name without its server prefix, else what kind of call it is. */
export function toolWord(call: CallFacts): string {
  if (call.tool !== undefined && call.tool !== "") {
    const parts = call.tool.split("__");
    return parts[parts.length - 1];
  }
  if (call.kind === "execute") {
    return "shell";
  }
  return call.kind;
}

/** The field names a tool's input uses for the file it is about. */
const PATH_FIELDS = ["path", "file_path", "filePath"];

/** The file a call is about, from its input, or undefined. */
export function fileOfCall(call: CallFacts): string | undefined {
  const input = call.rawInput;
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

/** How many times each tool was called among the items, in the order each first appears. */
export function talliesOf(items: readonly ViewItem[], callOf: (ref: string) => CallFacts | undefined): Tally[] {
  const tallies: Tally[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      continue;
    }
    const call = callOf(item.ref);
    if (call === undefined || call.diffs.length > 0) {
      continue;
    }
    const name = toolWord(call);
    let tally = tallies.find((entry) => entry.name === name);
    if (tally === undefined) {
      tally = { name, count: 0, files: [] };
      tallies.push(tally);
    }
    tally.count += 1;
    const file = fileOfCall(call);
    if (file !== undefined && !tally.files.includes(baseName(file))) {
      tally.files.push(baseName(file));
    }
  }
  return tallies;
}

/** The diffs inside a component. */
export function diffsIn(component: Component): DiffComponent[] {
  if (component.type === "diff") {
    return [component];
  }
  if (component.type === "card" || component.type === "row" || component.type === "stack") {
    return component.children.flatMap(diffsIn);
  }
  return [];
}

/** The files the items changed, once each, in the order each was first changed. */
export function changedFilesOf(items: readonly ViewItem[], callOf: (ref: string) => CallFacts | undefined): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const item of items) {
    const call = item.kind === "tool" ? callOf(item.ref) : undefined;
    if (call === undefined || item.state !== "done") {
      continue;
    }
    for (const diff of diffsIn(item.component)) {
      addChange(files, call, diff);
    }
  }
  return files;
}

/** Merges one diff into the entry of its file, or starts one. */
function addChange(files: ChangedFile[], call: CallFacts, diff: DiffComponent): void {
  const path = diff.path ?? "";
  const stats = diffStats(diff.lines);
  const known = files.find((file) => file.path === path);
  if (known !== undefined) {
    known.added += stats.added;
    known.removed += stats.removed;
    return;
  }
  const created = call.diffs.some((change) => change.path === path && change.oldText === undefined);
  files.push({ path, added: stats.added, removed: stats.removed, created });
}
