import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { bootKernel } from "../kernel/boot";
import { NpmRegistry, type InstalledExtension } from "../kernel/extensions";
import type { SlotEntry } from "../kernel/slots";
import { defineSettings, setting } from "../kernel/settings";
import { buildRows, type InstalledRow } from "../plugins/extensions/model";
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
  const browser = new ExtensionBrowser(kernel.extensions, new NpmRegistry({ baseUrl: () => "https://registry.test", fetch: registry.fetch }), kernel.settings);
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
      settings: [],
      openSettings: null,
    });
    expect(rows.map((row) => row.kind)).toEqual(["heading", "installed", "installed", "heading", "result", "result"]);
    expect(rows[1]).toMatchObject({ name: "a", title: "A", update: "1.1.0", enabled: true });
    expect(rows[2]).toMatchObject({ name: "b", update: null, enabled: false });
    expect(rows[4]).toMatchObject({ name: "a", installed: true });
    expect(rows[5]).toMatchObject({ name: "c", installed: false, activity: "installing" });
  });

  test("says why a section is empty, and shows a failed search as an error", () => {
    const empty = buildRows({ installed: [], results: [], searchState: "idle", searchError: null, latest: new Map(), activity: new Map(), settings: [], openSettings: null });
    expect(empty.filter((row) => row.kind === "message").map((row) => (row as { text: string }).text)).toEqual(["No extensions are installed.", "No extensions found."]);
    const failed = buildRows({ installed: [], results: [], searchState: "failed", searchError: "no network", latest: new Map(), activity: new Map(), settings: [], openSettings: null });
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

describe("an extension's settings in the view", () => {
  const SETTINGS_SCRIPT = `
    const { definePlugin, defineSettings, setting } = require("@grove/extension");
    definePlugin({
      Config: defineSettings({
        greeting: setting.string({ label: "Greeting", default: "hi" }),
        loud: setting.boolean({ label: "Loud", default: false, live: true }),
      }),
      inject: ["slots"],
      apply(ctx, config) {
        ctx.slots.register("statusbar", { id: "greeting:" + config.greeting + ":" + config.loud, component: require("@sample/component") });
      },
    });
  `;
  const MODULES = {
    "@grove/extension": { defineSettings, setting },
    "@sample/component": component,
  };

  /** A kernel that can run a script with settings, with the extension installed. */
  async function withSettingsExtension() {
    const disk = new Disk();
    const registry = new FakeRegistry();
    registry.publish(
      "grove-conf",
      "1.0.0",
      { plugins: [{ id: "main", title: "Greeting", main: "dist/main.js" }], settings: { level: { type: "number", label: "Level", default: 3 } } },
      { "dist/main.js": SETTINGS_SCRIPT },
    );
    const kernel = await bootKernel({
      catalog: { frame } as never,
      coreRows: [{ id: "frame", plugin: "frame" }],
      files: disk.profileFiles(),
      extensions: { files: disk.extensionFiles(), modules: MODULES },
    });
    await kernel.loaded;
    const browser = new ExtensionBrowser(kernel.extensions, new NpmRegistry({ baseUrl: () => "https://registry.test", fetch: registry.fetch }), kernel.settings);
    await browser.install("grove-conf");
    const installed = () => browser.rows().find((row) => row.kind === "installed") as InstalledRow;
    return { disk, kernel, browser, installed };
  }

  test("lists the settings of each plugin of the extension and of its manifest, with their values", async () => {
    const { installed } = await withSettingsExtension();
    expect(installed().settingCount).toBe(3);
    expect(installed().sections.map((section) => section.title)).toEqual(["Greeting", "Settings"]);
    expect(installed().sections[0].values).toEqual({ greeting: "hi", loud: false });
    expect(installed().sections[1].values).toEqual({ level: 3 });
    expect(installed().settingsOpen).toBe(false);
  });

  test("opening the form shows it for one extension at a time, and pressing again closes it", async () => {
    const { browser, installed } = await withSettingsExtension();
    browser.toggleSettings("grove-conf");
    expect(installed().settingsOpen).toBe(true);
    browser.toggleSettings("grove-conf");
    expect(installed().settingsOpen).toBe(false);
  });

  test("a change goes to the user's profile, restarts the plugin for a field that is not live and shows in the row", async () => {
    const { disk, kernel, installed } = await withSettingsExtension();
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["greeting:hi:false"]);

    await kernel.settings.set("grove-conf:main", "greeting", "hello there");

    expect(disk.files.get("/config/grove/profile.json")).toContain("hello there");
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["greeting:hello there:false"]);
    expect(installed().sections[0].values.greeting).toBe("hello there");
    expect(installed().sections[0].overridden).toEqual(["greeting"]);

    await kernel.settings.reset("grove-conf:main", "greeting");
    expect(installed().sections[0].overridden).toEqual([]);
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["greeting:hi:false"]);
  });

  test("the declared settings without a plugin are saved and read back through the extensions service", async () => {
    const { kernel, installed } = await withSettingsExtension();
    await kernel.settings.set("grove-conf:settings", "level", 5);
    expect(kernel.extensions.settingsOf("grove-conf")).toEqual({ level: 5 });
    expect(installed().sections[1].values).toEqual({ level: 5 });
    await expect(kernel.settings.set("grove-conf:settings", "level", "high" as never)).rejects.toThrow("must be a number");
  });

  test("a plugin that failed to load still shows its form, with the reason", async () => {
    const disk = new Disk();
    disk.install("broken", { plugins: [{ id: "boom", main: "dist/boom.js" }] }, { "dist/boom.js": "throw new Error('no good')" });
    const kernel = await bootKernel({
      catalog: { frame } as never,
      coreRows: [{ id: "frame", plugin: "frame" }],
      files: disk.profileFiles(),
      extensions: { files: disk.extensionFiles(), modules: MODULES },
    });
    await kernel.loaded;
    const registry = new FakeRegistry();
    const browser = new ExtensionBrowser(kernel.extensions, new NpmRegistry({ baseUrl: () => "https://registry.test", fetch: registry.fetch }), kernel.settings);
    const row = browser.rows().find((candidate) => candidate.kind === "installed") as InstalledRow;
    expect(row.sections).toHaveLength(1);
    expect(row.sections[0]).toMatchObject({ title: "boom", failure: "no good", fields: [] });
  });
});
