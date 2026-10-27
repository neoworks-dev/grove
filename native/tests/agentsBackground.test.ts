import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@suite/protocol/types";
import { ChatSession } from "../plugins/agents/chatSession";
import {
  JOB_LINGER_MS,
  applyBackground,
  backgroundOutput,
  jobTitle,
  lastLine,
  listedJobs,
  noBackground,
  readOutputInto,
  runtimeLabel,
  type BackgroundIo,
} from "../plugins/agents/background";
import { FakeClient } from "./support/fakeSuite";

const RESULT = "Command running in background with ID: abc. Output is being written to: /tmp/tasks/abc.output.";

/** The events of a background command: the call, then its result naming the output file. */
function started(seq = 1): { event: SessionEvent; seq: number }[] {
  return [
    {
      seq,
      event: { type: "tool_call", toolCallId: "t1", title: "bash: sleep 60", kind: "execute", status: "in_progress", rawInput: { command: "sleep 60", description: "Wait a minute" }, agent: "claude" },
    },
    { seq: seq + 1, event: { type: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "text", text: RESULT }] } },
  ];
}

/** The jobs after the events of `started`. */
function afterStart() {
  let state = noBackground();
  for (const { event, seq } of started()) {
    state = applyBackground(state, { session: "s", seq, ts: 5000, event });
  }
  return state;
}

describe("the output file a background result names", () => {
  test("is the path after the marker, without the closing dot", () => {
    expect(backgroundOutput(RESULT)).toBe("/tmp/tasks/abc.output");
    expect(backgroundOutput("exit 0")).toBeUndefined();
    expect(backgroundOutput("running in background; Output is being written to: relative.txt")).toBeUndefined();
  });
});

describe("following background commands", () => {
  test("a command whose result names an output file becomes a job with its description and agent", () => {
    const job = afterStart().jobs.get("t1");
    expect(job).toMatchObject({ command: "sleep 60", description: "Wait a minute", agent: "claude", path: "/tmp/tasks/abc.output", startedMs: 5000 });
    expect(jobTitle(job!)).toBe("Wait a minute");
  });

  test("a foreground command, or any other tool, is no job", () => {
    let state = noBackground();
    state = applyBackground(state, { session: "s", seq: 1, ts: 1, event: { type: "tool_call", toolCallId: "t2", title: "bash: ls", kind: "execute", status: "in_progress" } });
    state = applyBackground(state, { session: "s", seq: 2, ts: 2, event: { type: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "text", text: "a b" }] } });
    expect(state.jobs.size).toBe(0);
    expect(applyBackground(state, { session: "s", seq: 3, ts: 3, event: { type: "tool_call", toolCallId: "t3", title: "Read", kind: "read", status: "pending" } })).toBe(state);
  });

  test("reading the file keeps whole lines, lists the job once found running and ends it on the exit line", () => {
    const job = afterStart().jobs.get("t1")!;
    expect(listedJobs(new Map([[job.id, job]]), 6000)).toEqual([]);
    const running = readOutputInto(job, "step one\nstep tw", 6000);
    expect(running.output).toEqual(["step one"]);
    expect(running.seenRunning).toBe(true);
    expect(lastLine(running)).toBe("step one");
    expect(listedJobs(new Map([[job.id, running]]), 6000)).toHaveLength(1);
    expect(readOutputInto(running, "step one\nstep tw", 7000)).toBe(running);

    const ended = readOutputInto(running, "step one\nstep two\n\n[exited with code 2]\n", 9000);
    expect(ended.output).toEqual(["step one", "step two"]);
    expect(ended).toMatchObject({ exit: 2, endedMs: 9000 });
    expect(listedJobs(new Map([[job.id, ended]]), 9000 + JOB_LINGER_MS - 1)).toHaveLength(1);
    expect(listedJobs(new Map([[job.id, ended]]), 9000 + JOB_LINGER_MS)).toHaveLength(0);
  });

  test("a command replayed after it ended is never listed, and a missing file is given up on", () => {
    const job = afterStart().jobs.get("t1")!;
    const replayed = readOutputInto(job, "done\n[exited with code 0]\n", 100000);
    expect(replayed.endedMs).toBe(100000);
    expect(replayed.seenRunning).toBe(false);
    expect(listedJobs(new Map([[job.id, replayed]]), 100000)).toEqual([]);
    expect(readOutputInto(job, undefined, 6000).gone).toBe(false);
    expect(readOutputInto(job, undefined, 16000).gone).toBe(true);
  });

  test("the runtime reads as seconds, minutes and hours", () => {
    const job = afterStart().jobs.get("t1")!;
    expect(runtimeLabel(job, 5000 + 12_000)).toBe("12s");
    expect(runtimeLabel(job, 5000 + 185_000)).toBe("3m05s");
    expect(runtimeLabel(job, 5000 + 3_720_000)).toBe("1h02m");
  });
});

describe("a session following its background commands", () => {
  const chats: ChatSession[] = [];
  afterEach(() => {
    for (const chat of chats.splice(0)) {
      chat.stop();
    }
  });

  test("polls the file into the list, and stopping asks the host to stop what writes it", async () => {
    const client = new FakeClient();
    const chat = new ChatSession(client as never, "s", () => undefined);
    chats.push(chat);
    chat.start();
    await Promise.resolve();
    for (const { event } of started()) {
      client.events[0].emit(event);
    }
    let file: string | undefined = "hello\n";
    const stopped: string[] = [];
    const io: BackgroundIo = {
      readOutput: async () => file,
      stop: async (path) => void stopped.push(path),
    };
    chat.followBackground(io);
    await chat.pollBackground(Date.now());
    expect(chat.backgroundJobs().map((job) => lastLine(job))).toEqual(["hello"]);

    await chat.stopJob("t1");
    expect(stopped).toEqual(["/tmp/tasks/abc.output"]);

    file = "hello\n\n[exited with code 143]\n";
    await chat.pollBackground(Date.now());
    expect(chat.backgroundJobs()[0]).toMatchObject({ exit: 143 });
  });

  test("a refused stop shows as the pane's error", async () => {
    const client = new FakeClient();
    const chat = new ChatSession(client as never, "s", () => undefined);
    chats.push(chat);
    chat.start();
    await Promise.resolve();
    for (const { event } of started()) {
      client.events[0].emit(event);
    }
    chat.followBackground({
      readOutput: async () => "x\n",
      stop: async () => {
        throw new Error("could not stop the command: NothingToStop");
      },
    });
    await chat.stopJob("t1");
    expect(chat.error()).toBe("could not stop the command: NothingToStop");
  });
});
