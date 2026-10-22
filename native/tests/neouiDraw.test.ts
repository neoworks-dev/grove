import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Block, Component, UiDoc, UiNode, ViewItem } from "@suite/protocol/types";
import { ChatSession } from "../plugins/agents/chatSession";
import { markdownRows } from "../plugins/agents/chat/markdown";
import { INTERACTIVE } from "../plugins/agents/chat/openui/interactive";
import { FakeClient } from "./support/fakeSuite";

const here = import.meta.dir;
const openui = join(here, "../plugins/agents/chat/openui");

/** The neoworks-harness checkout the protocol is linked from, which holds the fixtures. */
const harness = dirname(Bun.resolveSync("@suite/protocol/package.json", here));

const doc = (root: UiNode, streaming = false): UiDoc => ({ id: "0", root, streaming });
const block = (ui: UiDoc): Block => ({ type: "openui", ui });

/** Every doc of the fixtures, whatever carries it. */
function docsOf(item: ViewItem): UiDoc[] {
  const out: UiDoc[] = [];
  const visit = (component: Component): void => {
    if (component.type === "openui") out.push(component.ui);
    else if (component.type === "text") {
      for (const part of component.blocks) if (part.type === "openui") out.push(part.ui);
    } else if ("children" in component) component.children.forEach(visit);
  };
  visit(item.component);
  return out;
}

/** The nodes of a tree, each once. */
function nodesOf(node: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(node);
  for (const value of Object.values(node.props)) {
    const list = Array.isArray(value) ? value.flat() : [value];
    for (const entry of list) {
      if (typeof entry === "object" && entry !== null && "component" in entry) nodesOf(entry as UiNode, out);
    }
  }
  return out;
}

/** The docs of every `openui-*` fixture, resolved the way the daemon sends them. */
function fixtureDocs(): UiDoc[] {
  const dir = join(harness, "../fixtures");
  const out: UiDoc[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith("openui-"))) {
    const items: ViewItem[] = JSON.parse(readFileSync(join(dir, name, "resolved.json"), "utf8"));
    out.push(...items.flatMap(docsOf));
  }
  return out;
}

test("every component the fixtures use is drawn, or is a line saying forms are still to come", () => {
  const source = readFileSync(join(openui, "Node.svelte"), "utf8");
  const drawn = new Set([...source.matchAll(/^\s{4}(\w+): /gm)].map((match) => match[1]));
  const docs = fixtureDocs();
  expect(docs.length).toBeGreaterThanOrEqual(5);
  const used = new Set(docs.flatMap((ui) => (ui.root === undefined ? [] : nodesOf(ui.root))).map((node) => node.component));
  // What sits under another component (a tab, an accordion item, a series) is drawn by its parent.
  const parts = new Set(["Tab", "AccordionItem", "Step", "KV", "ListItem", "Series", "Slice", "Option", "OptionCard", "CheckBoxItem", "SwitchItem", "FollowUpItem", "Row"]);
  const missing = [...used].filter((name) => !parts.has(name) && !drawn.has(name) && !INTERACTIVE.has(name));
  expect(missing).toEqual([]);
  for (const name of ["Stack", "Card", "Tabs", "Table", "BarChart", "FollowUpBlock", "Image"]) {
    expect(drawn.has(name)).toBe(true);
  }
});

test("an openui block among the markdown is a row of its own, in its place", () => {
  const ui = doc({ component: "Card", props: { children: [] } });
  const rows = markdownRows([
    { type: "paragraph", spans: [{ text: "before" }] },
    block(ui),
    { type: "paragraph", spans: [{ text: "after" }] },
  ]);
  expect(rows.map((row) => row.kind)).toEqual(["paragraph", "openui", "paragraph"]);
  const drawn = rows[1];
  expect(drawn?.kind === "openui" && drawn.ui).toBe(ui);
  expect(drawn?.gap).toBe("loose");
});

test("a neoui fence in a message of the fixtures reaches the chat as a row to draw", () => {
  const blocks = fixtureDocs().length;
  const rows = fixtureDocs().map((ui) => markdownRows([block(ui)])[0]);
  expect(rows).toHaveLength(blocks);
  expect(rows.every((row) => row?.kind === "openui")).toBe(true);
});

test("the chat draws a tool result that is a doc, and a doc inside a message", () => {
  const component = readFileSync(join(here, "../plugins/agents/chat/Component.svelte"), "utf8");
  const blocks = readFileSync(join(here, "../plugins/agents/chat/Blocks.svelte"), "utf8");
  expect(component).toContain('component.type === "openui"');
  expect(blocks).toContain('row.kind === "openui"');
});

test("a chat session says which directory pictures are read from, and has the daemon fetch web pictures", async () => {
  const client = new FakeClient();
  const chat = new ChatSession(client as never, "s", () => undefined, { directory: () => "/work/repo" });
  expect(chat.directory()).toBe("/work/repo");
  expect(await chat.fetchAsset("https://example.com/a.png")).toBe("asset://fetched-1");
  expect(client.fetched).toEqual(["https://example.com/a.png"]);
  expect(new ChatSession(client as never, "s", () => undefined).directory()).toBe("");
});
