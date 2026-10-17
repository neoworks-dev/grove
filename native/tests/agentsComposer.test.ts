import { afterEach, describe, expect, test } from "bun:test";
import type { Component, ViewItem } from "@suite/protocol/types";
import { ChatSession } from "../plugins/agents/chatSession";
import { ComposerModel } from "../plugins/agents/composerModel";
import { statusSegments } from "../plugins/agents/composerStatus";
import { History, historyFile, parseHistory, walksHistory, type HistoryStore } from "../plugins/agents/history";
import { TYPING_PAUSE_MS, splitPrompt, takesNote } from "../plugins/agents/prompt";
import { completion, isSlashWord, matchingCommands, moveSelection, SLASH_COMMANDS } from "../plugins/agents/slashCommands";
import { initialStatus } from "../plugins/agents/status";
import { FakeClient } from "./support/fakeSuite";

/** A history store in memory, which records what was appended. */
class FakeHistoryStore implements HistoryStore {
  saved = new Map<string, string[]>();
  appended: { session: string; text: string }[] = [];

  async load(session: string): Promise<History> {
    return new History(this.saved.get(session));
  }

  async append(session: string, text: string): Promise<void> {
    this.appended.push({ session, text });
  }
}

/** A permission question as the daemon's view draws it: a card with a button per answer. */
function question(ref: string, buttons: { label: string; action?: string; args?: unknown; current?: boolean }[]): ViewItem {
  const children: Component[] = [
    { type: "kv", items: [{ key: "file", value: "src/a.ts" }] },
    ...buttons.map((button) => ({
      type: "button" as const,
      label: button.label,
      action: button.action ?? "suite.permit",
      args: button.args ?? { id: ref, option: button.label },
      current: button.current,
    })),
  ];
  return { ref, kind: "tool", label: "Edit src/a.ts", state: "pending", component: { type: "card", children } };
}

interface Setup {
  client: FakeClient;
  chat: ChatSession;
  store: FakeHistoryStore;
  copied: string[];
  model: ComposerModel;
  /** Shows these items in the chat, as a view snapshot of the daemon would. */
  show: (items: ViewItem[]) => void;
}

const models: ComposerModel[] = [];

/** A composer over a chat of session `s` on a fake daemon. */
function setUp(): Setup {
  const client = new FakeClient();
  const chat = new ChatSession(client as never, "s", () => undefined);
  chat.start();
  const store = new FakeHistoryStore();
  const copied: string[] = [];
  const model = new ComposerModel(chat, { history: store, copyToClipboard: (text) => void copied.push(text) });
  models.push(model);
  return {
    client,
    chat,
    store,
    copied,
    model,
    show: (items) => client.views[0].snapshot({ session: "s", seq: 1, items }),
  };
}

afterEach(() => {
  for (const model of models.splice(0)) {
    model.dispose();
  }
});

describe("the slash commands", () => {
  test("a command being typed is a slash and no space yet", () => {
    expect(isSlashWord("/mo")).toBe(true);
    expect(isSlashWord("/model sonnet")).toBe(false);
    expect(isSlashWord("hello /mo")).toBe(false);
  });

  test("names starting with what is typed come first, and names containing it when none starts with it", () => {
    expect(matchingCommands("/mo").map((command) => command.name)).toEqual(["model", "mode"]);
    expect(matchingCommands("/").length).toBe(SLASH_COMMANDS.length);
    expect(matchingCommands("/ppr").map((command) => command.name)).toEqual(["approvals"]);
    expect(matchingCommands("/zzz")).toEqual([]);
  });

  test("a pick leaves room for arguments, and the highlight wraps", () => {
    expect(completion(SLASH_COMMANDS[0])).toBe("/clear ");
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe("the composer's menu", () => {
  test("opens while a command is typed, completes with Tab and closes with Esc until more is typed", () => {
    const { model } = setUp();
    model.text = "/mo";
    model.typed();
    expect(model.menuVisible()).toBe(true);
    expect(model.commands().map((command) => command.name)).toEqual(["model", "mode"]);
    model.moveMenu(1);
    model.complete();
    expect(model.text).toBe("/mode ");
    expect(model.menuVisible()).toBe(false);

    model.text = "/mo";
    expect(model.escape()).toBe(true);
    expect(model.menuVisible()).toBe(false);
    model.text = "/mod";
    expect(model.menuVisible()).toBe(true);
    expect(model.escape()).toBe(true);
    expect(model.escape()).toBe(false);
  });

  test("Enter sends the highlighted command, or completes one that needs arguments", () => {
    const { model, client } = setUp();
    model.text = "/appr";
    model.submit();
    expect(client.inputs).toEqual([{ session: "s", text: "/approvals" }]);
    expect(model.text).toBe("");
    model.text = "/claud";
    model.submit();
    expect(client.inputs).toHaveLength(1);
    expect(model.text).toBe("/claude ");
  });

  test("does not open over a text that is not a command", () => {
    const { model } = setUp();
    model.text = "hello";
    expect(model.menuVisible()).toBe(false);
    model.text = "/zzz";
    expect(model.menuVisible()).toBe(false);
  });
});

describe("the history", () => {
  test("Up walks back through what was sent and Down returns to the draft", () => {
    const { model } = setUp();
    for (const text of ["one", "two", "three"]) {
      model.text = text;
      model.submit();
    }
    model.text = "draft";
    expect(model.walkHistory("older", 80, false)).toBe(true);
    expect(model.text).toBe("three");
    model.walkHistory("older", 80, false);
    expect(model.text).toBe("two");
    model.walkHistory("newer", 80, false);
    expect(model.text).toBe("three");
    model.walkHistory("newer", 80, false);
    expect(model.text).toBe("draft");
    expect(model.walkHistory("newer", 80, false)).toBe(false);
  });

  test("leaves Up and Down to the cursor in text of several lines, unless forced", () => {
    const { model } = setUp();
    model.text = "sent";
    model.submit();
    model.text = "a\nb";
    expect(model.walkHistory("older", 80, false)).toBe(false);
    expect(model.walkHistory("older", 80, true)).toBe(true);
    expect(model.text).toBe("sent");
    expect(walksHistory("x".repeat(100), 80, false)).toBe(false);
  });

  test("keeps what was sent, once and per session, and loads it back", async () => {
    const { model, store } = setUp();
    model.text = "again";
    model.submit();
    model.text = "again";
    model.submit();
    expect(store.appended).toEqual([{ session: "s", text: "again" }]);

    const second = setUp();
    second.store.saved.set("s", ["old one", "old two"]);
    await second.model.loadHistory();
    second.model.walkHistory("older", 80, false);
    expect(second.model.text).toBe("old two");
  });

  test("a history file is lines of JSON strings, and only plain names have one", () => {
    expect(parseHistory('"a"\nnot json\n42\n"b\\nc"\n')).toEqual(["a", "b\nc"]);
    expect(historyFile("/d", "s_ab12")).toBe("/d/s_ab12.jsonl");
    expect(historyFile("/d", "../x")).toBeUndefined();
  });
});

describe("a question from the agent", () => {
  const edit = question("q1", [{ label: "Allow" }, { label: "Reject" }]);

  test("takes the input's place only once the user has paused typing", async () => {
    const { model, show } = setUp();
    model.text = "half a sent";
    model.typed();
    show([edit]);
    expect(model.prompt()?.ref).toBe("q1");
    expect(model.syncEngaged()).toBeGreaterThan(0);
    expect(model.engaged()).toBe(false);
    expect(model.waiting()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, TYPING_PAUSE_MS + 20));
    expect(model.syncEngaged()).toBeUndefined();
    expect(model.engaged()).toBe(true);
    expect(model.text).toBe("half a sent");
  });

  test("answers with the button pressed and puts the question aside", async () => {
    const { model, show, client } = setUp();
    show([edit]);
    model.syncEngaged();
    model.startPrompt(model.prompt());
    model.moveButton(1);
    model.press(model.button());
    expect(client.actions).toEqual([{ session: "s", ref: "q1", action: "suite.permit", args: { id: "q1", option: "Reject" } }]);
    expect(model.prompt()).toBeUndefined();
  });

  test("a note typed with Tab goes with the answer", () => {
    const { model, show, client } = setUp();
    show([edit]);
    model.startPrompt(model.prompt());
    model.tab();
    expect(model.note).toBe("");
    model.note = "use tabs";
    model.press(0);
    expect(client.actions[0].args).toEqual({ id: "q1", option: "Allow", note: "use tabs" });
    expect(model.note).toBeUndefined();
  });

  test("starts on the button in effect now", () => {
    const { model, show } = setUp();
    show([question("q2", [{ label: "a" }, { label: "b", action: "suite.choose", current: true }])]);
    model.startPrompt(model.prompt());
    expect(model.button()).toBe(1);
  });

  test("Esc puts it aside, and it comes back on request", () => {
    const { model, show } = setUp();
    show([edit]);
    expect(model.escape()).toBe(true);
    expect(model.prompt()).toBeUndefined();
    model.reopenPrompts();
    expect(model.prompt()?.ref).toBe("q1");
  });

  test("a copy button copies and leaves the question open", () => {
    const { model, show, client, copied } = setUp();
    show([question("q3", [{ label: "Copy", action: "copy:the text" }, { label: "Close" }])]);
    model.press(0);
    expect(copied).toEqual(["the text"]);
    expect(model.notice()).toBe("copied");
    expect(client.actions).toEqual([]);
    expect(model.prompt()?.ref).toBe("q3");
  });

  test("the oldest open question is the one answered, and an answered one is not open", () => {
    const { model, show } = setUp();
    const answered = { ...question("old", [{ label: "Allow" }]), state: "done" as const };
    show([answered, edit, question("q4", [{ label: "Allow" }])]);
    expect(model.prompt()?.ref).toBe("q1");
  });

  test("a card is split into its details and its buttons, with a choice's text as the button's description", () => {
    const split = splitPrompt({
      type: "card",
      children: [
        { type: "kv", items: [{ key: "k", value: "v" }] },
        { type: "row", children: [{ type: "button", label: "A", action: "x" }, { type: "text", blocks: [{ type: "paragraph", spans: [{ text: "about A" }] }] }] },
      ],
    });
    expect(split.body).toHaveLength(1);
    expect(split.buttons).toMatchObject([{ label: "A", description: "about A" }]);
    expect(takesNote({ label: "x", action: "suite.permit", args: { id: "1" }, current: false })).toBe(true);
    expect(takesNote({ label: "x", action: "suite.permit", current: false })).toBe(false);
  });
});

describe("the approvals mode", () => {
  test("the next mode is sent as a command, round the four", async () => {
    const { chat, client } = setUp();
    const events = client.events[0];
    await chat.cycleApprovals();
    events.emit({ type: "setting_changed", harness: "suite", option: "approvals", value: "review" });
    expect(chat.approvals()).toBe("review");
    await chat.cycleApprovals();
    events.emit({ type: "setting_changed", harness: "suite", option: "approvals", value: "auto" });
    await chat.cycleApprovals();
    expect(client.inputs.map((input) => input.text)).toEqual(["/approvals review", "/approvals edits", "/approvals ask"]);
  });

  test("the mode is shown first, in the tone of how much asks first", () => {
    const status = { ...initialStatus(), approvals: "auto" as const };
    expect(statusSegments(status)[0]).toEqual({ text: "auto", tone: "danger" });
    expect(statusSegments({ ...status, approvals: "review" })[0].tone).toBe("accent");
    expect(statusSegments({ ...status, approvals: "ask", running: true, usage: { type: "usage", contextUsed: 50, contextSize: 100, cost: 0.004 } })).toEqual([
      { text: "ask", tone: "muted" },
      { text: "pi", tone: "muted" },
      { text: "working", tone: "accent" },
      { text: "50% context", tone: "muted" },
      { text: "<$0.01", tone: "muted" },
    ]);
  });
});

describe("the chat's stub for a question being answered", () => {
  test("is kept while the composer answers it", () => {
    const { chat } = setUp();
    expect(chat.isAnswering("q1")).toBe(false);
    chat.setAnswering("q1");
    expect(chat.isAnswering("q1")).toBe(true);
    chat.setAnswering(undefined);
    expect(chat.isAnswering("q1")).toBe(false);
  });
});
