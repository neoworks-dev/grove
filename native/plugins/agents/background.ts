// The background commands an agent started: Claude Code ends a command it runs in the background
// at once, with where its output goes ("Output is being written to: <path>"), and writes
// `[exited with code N]` at the end of that file when the command ends. This follows the calls for
// such a result and reads the file. Plain functions, so they are tested without a window. Ported
// from neo term (apps/term widgets/terminal.rs and jobs.rs).

import type { SessionEventRecord, ToolCallContent } from "@suite/protocol/types";

/** Lines of output kept per command: the end of it. */
export const OUTPUT_LINES = 400;

/** How long a finished command stays in the list. */
export const JOB_LINGER_MS = 5000;

/** How long after it started a command may go without an output file before it is given up. */
const FILE_WAIT_MS = 10_000;

/** One background command. */
export interface BackgroundJob {
  /** The id of the tool call that started it. */
  id: string;
  /** The guest that ran it; absent for the session's own agent. */
  agent?: string;
  command: string;
  /** What the agent said it is for. */
  description?: string;
  /** The file its output goes to. */
  path: string;
  startedMs: number;
  /** Set once the file says the command exited. */
  endedMs?: number;
  exit?: number;
  /** Cleaned lines of the output, the last `OUTPUT_LINES`. */
  output: readonly string[];
  /** The text read so far, so an unchanged file costs nothing to read again. */
  readLength: number;
  /** Read while it still ran: a command replayed with the session's history is found ended at once and is not listed. */
  seenRunning: boolean;
  /** The file is not there: cleaned up, or on another machine. */
  gone: boolean;
}

/** What a tool call said about a command before its result named an output file. */
interface CommandFacts {
  command: string;
  description?: string;
  agent?: string;
}

/** The commands the calls started, and the background commands among them. */
export interface Background {
  readonly commands: ReadonlyMap<string, CommandFacts>;
  readonly jobs: ReadonlyMap<string, BackgroundJob>;
}

/** No commands yet. */
export function noBackground(): Background {
  return { commands: new Map(), jobs: new Map() };
}

/** The output file a result names: Claude Code's "Command running in background with ID: … Output is being written to: <path>." */
export function backgroundOutput(text: string): string | undefined {
  if (!text.includes("running in background")) {
    return undefined;
  }
  const marker = "Output is being written to: ";
  const at = text.indexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const word = text.slice(at + marker.length).trim().split(/\s+/)[0];
  if (word === undefined) {
    return undefined;
  }
  const path = word.replace(/\.$/, "");
  if (!path.startsWith("/")) {
    return undefined;
  }
  return path;
}

/** The command and its description from a call's input (`{ command, description }`), when it has them. */
function inputOf(rawInput: unknown): { command?: string; description?: string } {
  if (typeof rawInput !== "object" || rawInput === null) {
    return {};
  }
  const input = rawInput as Record<string, unknown>;
  const facts: { command?: string; description?: string } = {};
  if (typeof input.command === "string" && input.command !== "") {
    facts.command = input.command;
  }
  if (typeof input.description === "string" && input.description !== "") {
    facts.description = input.description;
  }
  return facts;
}

/**
 * The commands after one more event. Only `execute` calls are followed; one that goes to the
 * background gets a job when its result names the output file. Returns the same object when the
 * event changes nothing.
 */
export function applyBackground(state: Background, record: SessionEventRecord): Background {
  const { event } = record;
  if (event.type === "tool_call") {
    if (event.kind !== "execute") {
      return state;
    }
    const input = inputOf(event.rawInput);
    let command = input.command;
    if (command === undefined) {
      command = event.title.replace(/^bash: /, "");
    }
    const facts: CommandFacts = { command };
    if (input.description !== undefined) {
      facts.description = input.description;
    }
    if (event.agent !== undefined) {
      facts.agent = event.agent;
    }
    return { commands: new Map(state.commands).set(event.toolCallId, facts), jobs: state.jobs };
  }
  if (event.type !== "tool_call_update") {
    return state;
  }
  const known = state.commands.get(event.toolCallId);
  if (known === undefined) {
    return state;
  }
  const input = inputOf(event.rawInput);
  const facts: CommandFacts = { ...known };
  if (input.command !== undefined) {
    facts.command = input.command;
  }
  if (input.description !== undefined) {
    facts.description = input.description;
  }
  const commands = new Map(state.commands).set(event.toolCallId, facts);
  const path = pathOfResult(event.content);
  if (path === undefined || state.jobs.has(event.toolCallId)) {
    return { commands, jobs: state.jobs };
  }
  const job: BackgroundJob = {
    id: event.toolCallId,
    command: facts.command,
    path,
    startedMs: record.ts,
    output: [],
    readLength: 0,
    seenRunning: false,
    gone: false,
  };
  if (facts.description !== undefined) {
    job.description = facts.description;
  }
  if (facts.agent !== undefined) {
    job.agent = facts.agent;
  }
  return { commands, jobs: new Map(state.jobs).set(job.id, job) };
}

/** The output file a call's result text names, if it went to the background. */
function pathOfResult(content: readonly ToolCallContent[] | undefined): string | undefined {
  if (content === undefined) {
    return undefined;
  }
  const texts: string[] = [];
  for (const entry of content) {
    if (entry.type === "text") {
      texts.push(entry.text);
    }
  }
  return backgroundOutput(texts.join("\n"));
}

/** A line of output without colour codes and carriage returns. */
export function cleanLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

/** The exit code a line says (`[exited with code N]`), or undefined for any other line. */
export function exitCodeOf(line: string): number | undefined {
  const match = /^\[exited with code (-?\d+)\]$/.exec(line.trim());
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

/**
 * The job after reading its output file, `text` being the whole file or undefined when it could
 * not be read. Only complete lines count. The last line `[exited with code N]` ends the job and is
 * left out of the output, with the blank line before it.
 */
export function readOutputInto(job: BackgroundJob, text: string | undefined, nowMs: number): BackgroundJob {
  if (text === undefined) {
    if (job.readLength > 0 || nowMs - job.startedMs > FILE_WAIT_MS) {
      return { ...job, gone: true };
    }
    return job;
  }
  if (text.length === job.readLength) {
    return job;
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const next: BackgroundJob = { ...job, readLength: text.length };
  if (complete === "") {
    next.seenRunning = true;
    return next;
  }
  const lines = complete.split("\n").slice(0, -1).map(cleanLine);
  const code = exitCodeOf(lines[lines.length - 1] ?? "");
  if (code !== undefined) {
    lines.pop();
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    next.exit = code;
    next.endedMs = nowMs;
  } else {
    next.seenRunning = true;
  }
  next.output = lines.slice(-OUTPUT_LINES);
  return next;
}

/** Whether a job's file still needs reading: it has not ended and is not gone. */
export function isFollowed(job: BackgroundJob): boolean {
  return job.endedMs === undefined && !job.gone;
}

/** The jobs to list: those running, and those that ended a moment ago, oldest first. */
export function listedJobs(jobs: ReadonlyMap<string, BackgroundJob>, nowMs: number): BackgroundJob[] {
  const listed: BackgroundJob[] = [];
  for (const job of jobs.values()) {
    if (job.gone || !job.seenRunning) {
      continue;
    }
    if (job.endedMs !== undefined && nowMs - job.endedMs >= JOB_LINGER_MS) {
      continue;
    }
    listed.push(job);
  }
  return listed;
}

/** How long a job has run, as `12s`, `3m05s` or `1h02m`. */
export function runtimeLabel(job: BackgroundJob, nowMs: number): string {
  let end = nowMs;
  if (job.endedMs !== undefined) {
    end = job.endedMs;
  }
  const seconds = Math.max(0, Math.round((end - job.startedMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** What a job is called in the list: the agent's description of it, else the command. */
export function jobTitle(job: BackgroundJob): string {
  if (job.description !== undefined) {
    return job.description;
  }
  return job.command;
}

/** The last line of output that says anything. */
export function lastLine(job: BackgroundJob): string | undefined {
  for (let index = job.output.length - 1; index >= 0; index--) {
    const line = job.output[index];
    if (line !== undefined && line.trim() !== "") {
      return line.trim();
    }
  }
  return undefined;
}

/** What the app needs from the system to follow background commands. */
export interface BackgroundIo {
  /** The whole output file as text, or undefined when it cannot be read. */
  readOutput(path: string): Promise<string | undefined>;
  /** Stops the processes writing the file; rejects when none does. */
  stop(path: string): Promise<void>;
}
