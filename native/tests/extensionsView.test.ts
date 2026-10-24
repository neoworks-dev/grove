import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { bootKernel } from "../kernel/boot";
import { NpmRegistry, type InstalledExtension } from "../kernel/extensions";
import type { SlotEntry } from "../kernel/slots";
import { buildRows } from "../plugins/extensions/model";
import { ExtensionBrowser } from "../plugins/extensions/service";
import { Disk } from "./support/fakeExtensionDisk";
import { FakeRegistry } from "./support/fakeRegistry";

const component = (() => {}) as unknown as SlotEntry["component"];

const frame = {
  name: "frame",
  inject: ["slots"],
  apply(ctx: Context) {
    ctx.slots.declare("statusbar", "list");
  },
};

/** A plugin script that puts a status bar item named by `label`. */
function script(label: string): string {
  return `require("@grove/extension").definePlugin({ inject: ["slots"], apply(ctx) { ctx.slots.register("statusbar", { id: "${label}", component: require("@sample/component") }); } });`;
}

const PLUGIN = { plugins: [{ id: "item", main: "dist/item.js" }] };

/** A kernel over a fake disk, the browser on it, and the fake registry it talks to. */
async function setUp() {
  const disk = new Disk();
  const registry = new FakeRegistry();
  const kernel = await bootKernel({
    catalog: { frame } as never,
    coreRows: [{ id: "frame", plugin: "frame" }],
    files: disk.profileFiles(),
    extensions: { files: disk.extensionFiles(), modules: { "@grove/extension": {}, "@sample/component": component } },
  });
  await kernel.loaded;
  const browser = new ExtensionBrowser(kernel.extensions, new NpmRegistry({ baseUrl: () => "https://registry.test", fetch: registry.fetch }));
  const statusIds = () => kernel.slots.entries("statusbar").map((entry) => entry.id);
  return { disk, registry, kernel, browser, statusIds };
}

describe("buildRows", () => {
  const installed = (name: string, version: string, enabled = true): InstalledExtension => ({
    name,
    version,
    directory: `/data/extensions/${name}`,
    manifest: { name, version, title: name.toUpperCase(), description: "", plugins: [], grammars: [], languageServers: [], tools: [], themes: [], settings: {} },
    problems: [],
    enabled,
  });

  test("lists installed extensions first, with an update when the registry has a newer version", () => {
    const rows = buildRows({
      installed: [installed("a", "1.0.0"), installed("b", "2.0.0", false)],
      results: [{ name: "a", version: "1.1.0", description: "", keywords: [], publisher: "" }, { name: "c", version: "1.0.0", description: "", keywords: [], publisher: "" }],
      searchState: "idle",
      searchError: null,
      latest: new Map([["a", "1.1.0"], ["b", "2.0.0"]]),
      activity: new Map([["c", "installing"]]),
    });
    expect(rows.map((row) => row.kind)).toEqual(["heading", "installed", "installed", "heading", "result", "result"]);
    expect(rows[1]).toMatchObject({ name: "a", title: "A", update: "1.1.0", enabled: true });
    expect(rows[2]).toMatchObject({ name: "b", update: null, enabled: false });
    expect(rows[4]).toMatchObject({ name: "a", installed: true });
    expect(rows[5]).toMatchObject({ name: "c", installed: false, activity: "installing" });
  });

  test("says why a section is empty, and shows a failed search as an error", () => {
    const empty = buildRows({ installed: [], results: [], searchState: "idle", searchError: null, latest: new Map(), activity: new Map() });
    expect(empty.filter((row) => row.kind === "message").map((row) => (row as { text: string }).text)).toEqual(["No extensions are installed.", "No extensions found."]);
    const failed = buildRows({ installed: [], results: [], searchState: "failed", searchError: "no network", latest: new Map(), activity: new Map() });
    expect(failed.at(-1)).toMatchObject({ kind: "message", text: "no network", tone: "bad" });
  });
});

describe("ExtensionBrowser", () => {
  test("installing a search result loads its plugin without a restart", async () => {
    const { registry, browser, kernel, statusIds } = await setUp();
    registry.publish("grove-hello", "1.0.0", PLUGIN, { "dist/item.js": script("hello.item") });
    await browser.search("");
    expect(browser.rows().filter((row) => row.kind === "result")).toHaveLength(1);
    expect(statusIds()).toEqual([]);

    await browser.install("grove-hello");

    expect(statusIds()).toEqual(["hello.item"]);
    expect(kernel.extensions.installed().map((extension) => `${extension.name}@${extension.version}`)).toEqual(["grove-hello@1.0.0"]);
    expect(browser.rows().find((row) => row.kind === "result")).toMatchObject({ installed: true });
    expect(browser.notice()).toBeNull();
  });

  test("an update replaces the mounted plugin with the new version's", async () => {
    const { registry, browser, statusIds } = await setUp();
    registry.publish("grove-hello", "1.0.0", PLUGIN, { "dist/item.js": script("hello.v1") });
    await browser.install("grove-hello");
    expect(statusIds()).toEqual(["hello.v1"]);

    registry.publish("grove-hello", "1.1.0", PLUGIN, { "dist/item.js": script("hello.v2") });
    await browser.checkForUpdates();
    expect(browser.rows().find((row) => row.kind === "installed")).toMatchObject({ update: "1.1.0" });
    await browser.update("grove-hello");

    expect(statusIds()).toEqual(["hello.v2"]);
    expect(browser.rows().find((row) => row.kind === "installed")).toMatchObject({ version: "1.1.0", update: null });
  });

  test("an update leaves a disabled extension disabled", async () => {
    const { registry, browser, statusIds } = await setUp();
    registry.publish("grove-hello", "1.0.0", PLUGIN, { "dist/item.js": script("hello.v1") });
    await browser.install("grove-hello");
    await browser.setEnabled("grove-hello", false);
    expect(statusIds()).toEqual([]);
    registry.publish("grove-hello", "1.1.0", PLUGIN, { "dist/item.js": script("hello.v2") });
    await browser.update("grove-hello");
    expect(statusIds()).toEqual([]);
    expect(browser.rows().find((row) => row.kind === "installed")).toMatchObject({ version: "1.1.0", enabled: false });
  });

  test("removing deletes the files, unloads the plugin and forgets the disabled mark", async () => {
    const { disk, registry, browser, statusIds } = await setUp();
    registry.publish("grove-hello", "1.0.0", PLUGIN, { "dist/item.js": script("hello.item") });
    await browser.install("grove-hello");
    await browser.setEnabled("grove-hello", false);
    await browser.remove("grove-hello");
    expect(statusIds()).toEqual([]);
    expect([...disk.files.keys()].filter((path) => path.startsWith("/data/extensions/grove-hello"))).toEqual([]);
    expect(disk.files.get("/data/extensions/state.json")).not.toContain("grove-hello");
    expect(browser.rows().filter((row) => row.kind === "installed")).toEqual([]);
  });

  test("a scoped package installs into a directory without a slash", async () => {
    const { disk, registry, browser } = await setUp();
    registry.publish("@acme/tools", "1.0.0", {});
    await browser.install("@acme/tools");
    expect(disk.files.has("/data/extensions/@acme+tools/package.json")).toBe(true);
  });

  test("a package that is not an extension is refused and the notice says why", async () => {
    const { registry, browser, kernel } = await setUp();
    registry.publish("not-an-extension", "1.0.0", undefined);
    await browser.install("not-an-extension");
    expect(browser.notice()).toContain("not-an-extension is not a Grove extension");
    expect(kernel.extensions.installed()).toEqual([]);
    browser.clearNotice();
    expect(browser.notice()).toBeNull();
  });

  test("a registry that cannot be reached shows as an error in the list", async () => {
    const { registry, browser } = await setUp();
    registry.failing = "/-/v1/search";
    await browser.search("");
    const last = browser.rows().at(-1);
    expect(last).toMatchObject({ kind: "message", tone: "bad" });
    expect((last as { text: string }).text).toContain("could not reach the registry");
  });

  test("an answer to an older search does not replace the newer one", async () => {
    const { registry, browser } = await setUp();
    registry.publish("grove-aaa", "1.0.0", {});
    registry.publish("grove-bbb", "1.0.0", {});
    const slow = browser.search("aaa");
    await browser.search("bbb");
    await slow;
    expect(browser.rows().filter((row) => row.kind === "result").map((row) => (row as { name: string }).name)).toEqual(["grove-bbb"]);
  });
});
