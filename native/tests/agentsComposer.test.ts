import { afterEach, describe, expect, test } from "bun:test";
import type { Component, ViewItem } from "@suite/protocol/types";
import { ChatSession } from "../plugins/agents/chatSession";
import { ComposerModel } from "../plugins/agents/composerModel";
import { statusSegments } from "../plugins/agents/composerStatus";
import { History, historyFile, parseHistory, walksHistory, type HistoryStore } from "../plugins/agents/history";
import { TYPING_PAUSE_MS, splitPrompt, takesNote } from "../plugins/agents/prompt";
import { completion, isSlashWord, matchingCommands, moveSelection, SLASH_COMMANDS } from "../plugins/agents/slashCommands";
import { isImagePath, pastedImagePaths, withAttachment } from "../plugins/agents/attachments";
import { accept, candidatesFor, entriesOf, mentionAt } from "../plugins/agents/mention";
import { doneCount, toggleChange } from "../plugins/agents/todos";
import { queuedRow, queuedRows } from "../plugins/agents/queued";
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
      { text: "neo", tone: "muted" },
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

describe("the menu's commands from the harness", () => {
  /** A composer whose session has gone live and heard what neo lists. */
  async function withListedCommands(): Promise<Setup> {
    const setup = setUp();
    await Promise.resolve();
    setup.client.events[0].emit({
      type: "commands_available",
      harness: "neo",
      commands: [{ name: "review", description: "review a branch", hint: "branch" }, { name: "model", description: "theirs" }],
    });
    return setup;
  }

  test("lists the harness's commands after ours, and ours win a name clash", async () => {
    const { model } = await withListedCommands();
    model.text = "/";
    expect(model.commands().map((command) => command.name)).toContain("review");
    const review = model.commands().find((command) => command.name === "review");
    expect(review).toMatchObject({ args: "branch", desc: "review a branch", local: false });
    const clash = model.commands().filter((command) => command.name === "model");
    expect(clash).toHaveLength(1);
    expect(clash[0].desc).toContain("replaces");
  });

  test("a harness command is sent as the user's text", async () => {
    const { model, client } = await withListedCommands();
    model.text = "/revi";
    model.submit();
    expect(client.inputs).toEqual([{ session: "s", text: "/review" }]);
  });
});

describe("the pane's own commands", () => {
  test("/help opens the full menu and sends nothing", () => {
    const { model, client } = setUp();
    model.text = "/help";
    model.submit();
    expect(client.inputs).toEqual([]);
    expect(model.text).toBe("/");
    expect(model.menuVisible()).toBe(true);
    expect(model.commands().length).toBe(SLASH_COMMANDS.length);
  });

  test("the menu lists term's daemon commands and names neo in /harness", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    for (const name of ["cd", "settings", "safesearch", "login", "logout", "accounts", "plugin", "help"]) {
      expect(names).toContain(name);
    }
    expect(SLASH_COMMANDS.find((command) => command.name === "harness")?.args).toBe("[neo|claude|codex]");
  });
});

describe("the queue of messages sent while a turn runs", () => {
  test("lists the first rows of the waiting messages and counts the rest", () => {
    const waiting = (text: string) => ({ app: "grove", text });
    expect(queuedRow({ app: "a", text: "fix it\nand the tests", images: ["/a.png", "/b.png"] })).toBe("fix it …  [2 images]");
    expect(queuedRows([waiting("one"), waiting("two")])).toEqual({ shown: ["one", "two"], hidden: 0 });
    expect(queuedRows([1, 2, 3, 4, 5].map((n) => waiting(`m${n}`)))).toEqual({ shown: ["m1", "m2"], hidden: 3 });
  });

  test("Up takes the waiting messages back into the editor ahead of what was typed", async () => {
    const client = new FakeClient();
    const waiting = [{ app: "grove", text: "first" }, { app: "grove", text: "second" }];
    const chat = new ChatSession(client as never, "s", () => undefined, { waiting: () => waiting });
    const model = new ComposerModel(chat, { history: new FakeHistoryStore(), copyToClipboard: () => {} });
    models.push(model);
    client.unqueued = [...waiting];
    model.text = "meanwhile";
    expect(await model.takeBackWaiting()).toBe(true);
    expect(model.text).toBe("first\n\nsecond\n\nmeanwhile");
    expect(client.unqueueCalls).toEqual(["s"]);
  });

  test("with nothing waiting, Up does not ask the daemon", async () => {
    const { model, client } = setUp();
    expect(await model.takeBackWaiting()).toBe(false);
    expect(client.unqueueCalls).toEqual([]);
  });
});

describe("the shared todo list", () => {
  test("/todo adds an item through the daemon's neo.todos action and sends no message", async () => {
    const { model, client } = setUp();
    model.text = "/todo buy milk";
    model.submit();
    await Promise.resolve();
    expect(client.inputs).toEqual([]);
    expect(client.actions).toEqual([{ session: "s", ref: "todos", action: "neo.todos", args: { action: "add", text: "buy milk" } }]);
    expect(model.text).toBe("");
  });

  test("/todo alone completes in the menu and, sent empty, only says how to use it", () => {
    const { model, client } = setUp();
    model.text = "/tod";
    model.submit();
    expect(model.text).toBe("/todo ");
    model.text = "/todo  ";
    model.submit();
    expect(client.actions).toEqual([]);
    expect(model.notice()).toBe("usage: /todo <what to do>");
  });

  test("the session keeps the list the newest todos event left, and toggling asks for done or undone", async () => {
    const { chat, client } = setUp();
    await Promise.resolve();
    const items = [{ id: "t1", text: "a", done: false }, { id: "t2", text: "b", done: true, by: "neo" }];
    client.events[0].emit({ type: "todos", items });
    expect(chat.todos()).toEqual(items);
    expect(doneCount(chat.todos())).toBe(1);
    expect(toggleChange(items[0])).toEqual({ action: "done", id: "t1" });
    expect(toggleChange(items[1])).toEqual({ action: "undone", id: "t2" });
    client.events[0].emit({ type: "todos", items: [] });
    expect(chat.todos()).toEqual([]);
  });
});

describe("@ file mentions", () => {
  const FILES = ["README.md", "src/app.ts", "src/lib/util.ts", "src/lib/mention.ts", "docs/guide.md"];

  test("the word at the cursor is a mention when it starts with an at", () => {
    expect(mentionAt("look at @src/ap", 15)).toEqual({ start: 8, query: "src/ap" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail me@x.de", 12)).toBeUndefined();
    expect(mentionAt("@a done", 7)).toBeUndefined();
    expect(mentionAt("two\n@do", 7)?.start).toBe(4);
  });

  test("an empty query lists a folder's own entries, folders first; a name is matched loosely below it", () => {
    const entries = entriesOf(FILES);
    expect(candidatesFor(entries, "").map((candidate) => candidate.path)).toEqual(["docs/", "src/", "README.md"]);
    expect(candidatesFor(entries, "src/").map((candidate) => candidate.path)).toEqual(["src/lib/", "src/app.ts"]);
    expect(candidatesFor(entries, "ap").map((candidate) => candidate.path)[0]).toBe("src/app.ts");
    expect(candidatesFor(entries, "src/me").map((candidate) => candidate.path)).toEqual(["src/lib/mention.ts"]);
    expect(candidatesFor(entries, "gde")[0]?.path).toBe("docs/guide.md");
    expect(candidatesFor(entries, "../x")).toEqual([]);
  });

  test("picking a file replaces the word and ends it, picking a folder keeps the list open in it", () => {
    const mention = { start: 4, query: "sr" };
    expect(accept("see @sr and more", 7, mention, { path: "src/", dir: true })).toEqual({ text: "see @src/ and more", cursor: 9 });
    expect(accept("see @ap", 7, { start: 4, query: "ap" }, { path: "src/app.ts", dir: false })).toEqual({
      text: "see @src/app.ts ",
      cursor: 16,
    });
  });

  test("the composer lists the session's files while an @ word is typed, and Enter puts the pick in the draft", async () => {
    const client = new FakeClient();
    const chat = new ChatSession(client as never, "s", () => undefined, {
      directory: () => "/repo",
      listFiles: async (directory) => (directory === "/repo" ? FILES : []),
    });
    const model = new ComposerModel(chat, { history: new FakeHistoryStore(), copyToClipboard: () => {} });
    models.push(model);
    model.text = "read @app";
    expect(model.mentionMatches()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.mentionMatches().map((candidate) => candidate.path)).toEqual(["src/app.ts"]);
    expect(model.mentionVisible()).toBe(true);
    expect(model.acceptMention()).toBe("read @src/app.ts ".length);
    expect(model.text).toBe("read @src/app.ts ");
    expect(model.mentionVisible()).toBe(false);
  });

  test("Esc closes the list until more is typed, and the cursor decides which word is the mention", async () => {
    const client = new FakeClient();
    const chat = new ChatSession(client as never, "s", () => undefined, { directory: () => "/repo", listFiles: async () => FILES });
    const model = new ComposerModel(chat, { history: new FakeHistoryStore(), copyToClipboard: () => {} });
    models.push(model);
    model.text = "@ap later";
    model.moved(3);
    model.mentionMatches();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.mentionVisible()).toBe(true);
    model.moved(9);
    expect(model.mentionVisible()).toBe(false);
    model.moved(3);
    expect(model.escape()).toBe(true);
    expect(model.mentionVisible()).toBe(false);
    model.text = "@app later";
    expect(model.mentionVisible()).toBe(true);
  });
});

describe("attached images", () => {
  /** A composer with a fake clipboard that holds an image, some text, or neither. */
  function withClipboard(clipboard: { image?: string; text?: string; existing?: string[] }) {
    const client = new FakeClient();
    const chat = new ChatSession(client as never, "s", () => undefined);
    const model = new ComposerModel(chat, {
      history: new FakeHistoryStore(),
      copyToClipboard: () => {},
      clipboard: {
        image: async () => clipboard.image ?? null,
        text: async () => clipboard.text ?? "",
        exists: async (path) => (clipboard.existing ?? []).includes(path),
      },
    });
    models.push(model);
    return { client, model };
  }

  test("the paths a pasted text names, and only when it names nothing else", () => {
    expect(pastedImagePaths("/home/me/a.png")).toEqual(["/home/me/a.png"]);
    expect(pastedImagePaths("'/tmp/a b.JPG'\nfile:///tmp/c%20d.webp")).toEqual(["/tmp/a b.JPG", "/tmp/c d.webp"]);
    expect(pastedImagePaths("see /home/me/a.png")).toBeUndefined();
    expect(pastedImagePaths("/home/me/notes.txt")).toBeUndefined();
    expect(pastedImagePaths("a.png")).toBeUndefined();
    expect(isImagePath("x.gif")).toBe(true);
    expect(withAttachment([{ id: 1, path: "/a.png" }], "/a.png")).toHaveLength(1);
  });

  test("Ctrl+V attaches the clipboard's image and the next message carries it, with or without text", async () => {
    const { model, client } = withClipboard({ image: "/tmp/grove-paste/paste-1.png" });
    expect(await model.paste()).toBeUndefined();
    expect(model.attachments()).toEqual([{ id: 1, path: "/tmp/grove-paste/paste-1.png" }]);
    model.text = "what is this";
    model.submit();
    expect(client.inputs).toEqual([{ session: "s", text: "what is this", images: ["/tmp/grove-paste/paste-1.png"] }]);
    expect(model.attachments()).toEqual([]);
    await model.paste();
    model.submit();
    expect(client.inputs[1]).toMatchObject({ text: "", images: ["/tmp/grove-paste/paste-1.png"] });
  });

  test("pasted image paths are attached when the files exist, else pasted as text", async () => {
    const found = withClipboard({ text: "/tmp/a.png", existing: ["/tmp/a.png"] });
    expect(await found.model.paste()).toBeUndefined();
    expect(found.model.attachments().map((attachment) => attachment.path)).toEqual(["/tmp/a.png"]);
    const missing = withClipboard({ text: "/tmp/a.png" });
    expect(await missing.model.paste()).toBe("/tmp/a.png");
    expect(missing.model.attachments()).toEqual([]);
    const plain = withClipboard({ text: "just words" });
    expect(await plain.model.paste()).toBe("just words");
  });

  test("a detached image does not go, dropped files attach only their images, and a command takes none", () => {
    const { model, client } = withClipboard({});
    expect(model.dropped(["/a.png", "/notes.txt", "/b.jpg"])).toBe(2);
    model.detach(1);
    expect(model.attachments()).toEqual([{ id: 2, path: "/b.jpg" }]);
    model.text = "/clear";
    model.submit();
    expect(client.inputs).toEqual([{ session: "s", text: "/clear" }]);
    expect(model.attachments()).toHaveLength(1);
  });

  test("text is inserted in place of the selection", () => {
    const { model } = withClipboard({});
    model.text = "hello world";
    expect(model.insertText("big ", 6, 6)).toBe(10);
    expect(model.text).toBe("hello big world");
    expect(model.insertText("X", 0, 5)).toBe(1);
    expect(model.text).toBe("X big world");
  });
});

describe("the draft put aside", () => {
  test("Ctrl-S puts the draft and its images aside, and again brings them back, trading with what is typed", () => {
    const { model } = setUp();
    model.text = "a long half-written message";
    model.attach("/a.png");
    model.swapStash();
    expect(model.text).toBe("");
    expect(model.attachments()).toEqual([]);
    expect(model.hasStash()).toBe(true);
    model.text = "quick one";
    model.swapStash();
    expect(model.text).toBe("a long half-written message");
    expect(model.attachments().map((attachment) => attachment.path)).toEqual(["/a.png"]);
    model.swapStash();
    expect(model.text).toBe("quick one");
    expect(model.hasStash()).toBe(true);
  });

  test("sending what was typed in its place brings the draft back, and an empty input puts nothing aside", () => {
    const { model, client } = setUp();
    model.swapStash();
    expect(model.hasStash()).toBe(false);
    model.text = "the long draft";
    model.swapStash();
    model.text = "ask first";
    model.submit();
    expect(client.inputs).toEqual([{ session: "s", text: "ask first" }]);
    expect(model.text).toBe("the long draft");
    expect(model.hasStash()).toBe(false);
  });
});
