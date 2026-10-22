import { expect, test } from "bun:test";
import type { UiDoc, UiNode } from "@suite/protocol/types";
import { DocSession, type Held, type HeldView } from "../plugins/agents/chat/openui/session";
import { outbox } from "../plugins/agents/chat/openui/form";

type Sent = { ref: string; action: string; args: unknown };

function rig(ui: Partial<UiDoc> = {}): {
  session: DocSession;
  sent: Sent[];
  opened: string[];
  copied: string[];
  held: Record<string, Held>;
} {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const held: Record<string, Held> = {};
  const view: HeldView = {
    held,
    hold: (key, value) => void (held[key] = { value, at: 0 }),
  };
  const doc: UiDoc = { id: "0", ...ui };
  const session = new DocSession(() => ({
    ref: "m-1",
    ui: doc,
    view,
    send: (ref, action, args) => void sent.push({ ref, action, args }),
    open: (url) => void opened.push(url),
    copy: (text) => void copied.push(text),
  }));
  return { session, sent, opened, copied, held };
}

const field = (key: string, value?: unknown): UiNode => {
  const props: Record<string, unknown> = {};
  if (value !== undefined) props["value"] = value;
  return { component: "Input", key, props };
};
const button = (key: string, props: Record<string, unknown> = {}): UiNode => ({
  component: "Button",
  key,
  props: { label: key, ...props },
});

test("a field's value is what was chosen here until the daemon catches up, else the daemon's", () => {
  const { session, held } = rig();
  const name = field("name", "from daemon");
  expect(session.value(name)).toBe("from daemon");
  held["name"] = { value: "chosen", at: 0 };
  expect(session.value(name)).toBe("chosen");
  expect(session.value(field("other"))).toBeUndefined();
});

test("a chosen value shows at once and is sent at once to the doc of its item", () => {
  const { session, sent, held } = rig();
  session.input(field("dry"), true);
  expect(held["dry"]?.value).toBe(true);
  expect(sent).toEqual([
    { ref: "m-1", action: "openui.input", args: { doc: "0", key: "dry", value: true } },
  ]);
});

test("typing is sent after a pause and keeps no held value, so the field keeps its own text", async () => {
  const { session, sent, held } = rig();
  const name = field("typed");
  session.input(name, "a", { soon: true, hold: false });
  session.input(name, "ab", { soon: true, hold: false });
  expect(sent).toEqual([]);
  expect(held["typed"]).toBeUndefined();
  await Bun.sleep(260);
  expect(sent.map((s) => s.args)).toEqual([{ doc: "0", key: "typed", value: "ab" }]);
});

test("leaving a field sends what it waits to send", async () => {
  const { session, sent } = rig();
  const name = field("left");
  session.input(name, "text", { soon: true, hold: false });
  session.flush(name);
  expect(sent.map((s) => s.args)).toEqual([{ doc: "0", key: "left", value: "text" }]);
  await Bun.sleep(260);
  expect(sent).toHaveLength(1);
});

test("nothing is sent or pressed while the doc is streaming", () => {
  const { session, sent, held, opened } = rig({ streaming: true });
  session.input(field("a"), "x");
  session.press(button("go"));
  session.press(button("link", { url: "https://example.com" }));
  expect(sent).toEqual([]);
  expect(held).toEqual({});
  expect(opened).toEqual([]);
});

test("a press sends the typed text first and then the press, and a disabled button sends nothing", () => {
  const { session, sent } = rig();
  session.input(field("who"), "ada", { soon: true, hold: false });
  session.press(button("go"));
  expect(sent.map((s) => [s.action, s.args])).toEqual([
    ["openui.input", { doc: "0", key: "who", value: "ada" }],
    ["openui.press", { doc: "0", key: "go" }],
  ]);
  session.press(button("off", { disabled: true }));
  expect(sent).toHaveLength(2);
  expect(outbox.waiting).toBe(false);
});

test("a button with a link opens it and one with text to copy copies it, neither tells the daemon", () => {
  const { session, sent, opened, copied } = rig();
  session.press(button("docs", { url: "https://example.com/docs" }));
  session.press(button("copy", { copy: "npm i" }));
  expect(opened).toEqual(["https://example.com/docs"]);
  expect(copied).toEqual(["npm i"]);
  expect(sent).toEqual([]);
});

test("Enter in a field presses the form's first button, else the doc's first", () => {
  const form: UiNode = {
    component: "Form",
    props: {
      children: [field("a")],
      buttons: { component: "Buttons", props: { buttons: [button("send")] } },
    },
  };
  const { session } = rig({
    root: { component: "Stack", props: { children: [button("first"), form] } },
  });
  expect(session.firstButton(form)?.key).toBe("send");
  expect(session.firstButton()?.key).toBe("first");
  expect(session.rootNode?.component).toBe("Stack");
});
