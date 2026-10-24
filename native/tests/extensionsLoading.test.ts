import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { bootKernel } from "../kernel/boot";
import { evaluateExtensionScript, type Contributions, type ToolsHost } from "../kernel/extensions";
import { defineSettings, setting } from "../kernel/settings";
import type { SlotEntry } from "../kernel/slots";
import { theme } from "../plugins/theme";
import { Disk } from "./support/fakeExtensionDisk";

const component = (() => {}) as unknown as SlotEntry["component"];

/** Plugin scripts the way the build leaves them: asking the app for what they share. */
const STATUS_SCRIPT = `
  const { definePlugin } = require("@grove/extension");
  definePlugin({
    inject: ["slots"],
    apply(ctx) {
      ctx.slots.register("statusbar", { id: "sample.item", component: require("@sample/component") });
    },
  });
`;

const modules = { "@grove/extension": { defineSettings, setting }, "@sample/component": component };

const frame = {
  name: "frame",
  inject: ["slots"],
  apply(ctx: Context) {
    ctx.slots.declare("statusbar", "list");
  },
};

/** Boots a kernel with the disk's extensions and a frame that declares the status bar. */
async function boot(disk: Disk, extraCatalog: Record<string, unknown> = {}, extraRows: object[] = []) {
  const kernel = await bootKernel({
    catalog: { frame, ...extraCatalog } as never,
    coreRows: [{ id: "frame", plugin: "frame" }, ...extraRows] as never,
    files: disk.profileFiles(),
    extensions: { files: disk.extensionFiles(), modules },
  });
  await kernel.loaded;
  return kernel;
}

const STATUS_PLUGIN = { plugins: [{ id: "item", main: "dist/item.js" }] };

describe("installed extensions", () => {
  test("an installed extension's plugin is mounted and fills its slot", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const kernel = await boot(disk);
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["sample.item"]);
    const report = kernel.loader.reports().find((row) => row.id === "sample:item");
    expect(report).toMatchObject({ status: "active", layer: "extensions" });
  });

  test("an extension on the disabled list is not loaded", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    disk.files.set("/data/extensions/state.json", JSON.stringify({ disabled: ["sample"] }));
    const kernel = await boot(disk);
    expect(kernel.slots.entries("statusbar")).toEqual([]);
    expect(kernel.extensions.installed()[0]).toMatchObject({ name: "sample", enabled: false });
  });

  test("switching an extension on and off mounts and unmounts its plugin", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const kernel = await boot(disk);
    await kernel.extensions.setEnabled("sample", false);
    expect(kernel.slots.entries("statusbar")).toEqual([]);
    expect(disk.files.get("/data/extensions/state.json")).toContain("sample");
    await kernel.extensions.setEnabled("sample", true);
    expect(kernel.slots.entries("statusbar")).toHaveLength(1);
  });

  test("the user's profile can disable an extension plugin by its row id", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    disk.files.set("/config/grove/profile.json", '[{"id":"sample:item","disabled":true}]');
    const kernel = await boot(disk);
    expect(kernel.slots.entries("statusbar")).toEqual([]);
    expect(kernel.loader.reports().find((row) => row.id === "sample:item")?.status).toBe("disabled");
  });

  test("a script that throws shows up as a failed row and the others still load", async () => {
    const disk = new Disk();
    disk.install("broken", { plugins: [{ id: "boom", main: "dist/boom.js" }] }, { "dist/boom.js": "throw new Error('script exploded')" });
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const kernel = await boot(disk);
    const failed = kernel.loader.failures();
    expect(failed.map((row) => row.id)).toEqual(["broken:boom"]);
    expect(failed[0].message).toContain("script exploded");
    expect(kernel.slots.entries("statusbar")).toHaveLength(1);
    expect(kernel.extensions.installed().find((extension) => extension.name === "broken")?.problems[0]).toContain("script exploded");
  });

  test("a missing script is a failed row with its path in the message", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, {});
    const kernel = await boot(disk);
    expect(kernel.loader.failures()[0].message).toContain("dist/item.js does not exist");
  });

  test("a directory that is not an extension is listed with its problems and loads nothing", async () => {
    const disk = new Disk();
    disk.files.set("/data/extensions/stray/readme.txt", "hello");
    disk.files.set("/data/extensions/plain/package.json", JSON.stringify({ name: "plain" }));
    const kernel = await boot(disk);
    const found = kernel.extensions.installed();
    expect(found.map((extension) => extension.name)).toEqual(["plain", "stray"]);
    expect(found.every((extension) => extension.manifest === null && extension.problems.length > 0)).toBe(true);
    expect(kernel.loader.reports().map((row) => row.id)).toEqual(["frame"]);
  });

  test("the plugin declared settings appear on the settings page with their defaults", async () => {
    const disk = new Disk();
    const script = `
      const { definePlugin, defineSettings, setting } = require("@grove/extension");
      definePlugin({
        Config: defineSettings({ greeting: setting.string({ label: "Greeting", default: "hi" }) }),
        apply() {},
      });
    `;
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": script });
    const kernel = await boot(disk);
    const entry = kernel.settings.entries().find((candidate) => candidate.rowId === "sample:item");
    expect(entry?.values).toEqual({ greeting: "hi" });
    await kernel.settings.set("sample:item", "greeting", "hello there");
    expect(disk.files.get("/config/grove/profile.json")).toContain("hello there");
    expect(kernel.settings.entries().find((candidate) => candidate.rowId === "sample:item")?.values).toEqual({ greeting: "hello there" });
  });

  test("settings declared in the manifest get a row of their own", async () => {
    const disk = new Disk();
    disk.install("sample", { settings: { level: { type: "number", label: "Level", default: 3 } } });
    const kernel = await boot(disk);
    expect(kernel.extensions.settingsOf("sample")).toEqual({ level: 3 });
    await kernel.settings.set("sample:settings", "level", 7);
    expect(kernel.extensions.settingsOf("sample")).toEqual({ level: 7 });
  });

  test("themes the manifest declares are registered with the theme service", async () => {
    const disk = new Disk();
    disk.install(
      "sample",
      { themes: [{ id: "night", name: "Night", scheme: "dark", file: "themes/night.json" }] },
      { "themes/night.json": JSON.stringify({ tokens: { accent: "#ff00ff" } }) },
    );
    const kernel = await boot(disk, { theme }, [{ id: "theme", plugin: "theme" }]);
    const themes = kernel.context.theme.themes();
    const night = themes.find((candidate) => candidate.id === "sample:night");
    expect(night?.name).toBe("Night");
    expect(night?.tokens.accent).toBe("#ff00ff");
    expect(night?.tokens.canvas).toBeDefined();
  });

  test("grammars, language servers and tools of enabled extensions are listed with their origin", async () => {
    const disk = new Disk();
    disk.install("sample", {
      grammars: [{ language: "toml", wasm: "toml.wasm", extensions: ["toml"] }],
      languageServers: [{ id: "taplo", command: "taplo", languageId: "toml", extensions: ["toml"] }],
    });
    const kernel = await boot(disk);
    expect(kernel.extensions.grammars()[0]).toMatchObject({ language: "toml", extension: "sample", directory: "/data/extensions/sample" });
    expect(kernel.extensions.languageServers()[0]).toMatchObject({ id: "taplo", name: "taplo" });
    await kernel.extensions.setEnabled("sample", false);
    expect(kernel.extensions.grammars()).toEqual([]);
  });

  test("the bundle's own catalog is left alone", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const catalog = { frame };
    await bootKernel({ catalog: catalog as never, coreRows: [], files: disk.profileFiles(), extensions: { files: disk.extensionFiles(), modules } });
    expect(Object.keys(catalog)).toEqual(["frame"]);
  });

  test("an update that changes the plugin script replaces the mounted plugin", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const kernel = await boot(disk);
    const before = kernel.slots.entries("statusbar")[0];
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT.replace("sample.item", "sample.renamed") });
    disk.files.set("/data/extensions/sample/package.json", JSON.stringify({ name: "sample", version: "2.0.0", grove: STATUS_PLUGIN }));
    await kernel.profile.reload();
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["sample.renamed"]);
    expect(kernel.slots.entries("statusbar")[0]).not.toBe(before);
  });
});

describe("evaluateExtensionScript", () => {
  test("hands the script only the modules it was given", () => {
    expect(() => evaluateExtensionScript("require('fs')", "x/y.js", {})).toThrow('needs the module "fs"');
  });

  test("a script that contributes nothing says what to call", () => {
    expect(() => evaluateExtensionScript("1 + 1", "x/y.js", {})).toThrow("definePlugin");
  });

  test("a syntax error names the script", () => {
    expect(() => evaluateExtensionScript("let = ;", "x/y.js", {})).toThrow("x/y.js could not be read");
  });

  test("a plugin assigned to module.exports counts too", () => {
    const plugin = evaluateExtensionScript("module.exports = { apply() {} }", "x/y.js", {});
    expect(typeof (plugin as { apply: unknown }).apply).toBe("function");
  });
});

describe("what extensions hand the host", () => {
  const TAPLO_RECIPE = {
    kind: "github-release",
    repo: "tamasfe/taplo",
    assets: { "linux-x64": "taplo-linux-x86_64.gz" },
    binaries: ["taplo"],
  };

  /** A kernel with a fake host that remembers what it was handed. */
  async function bootWithHost(disk: Disk) {
    const handed: Contributions[] = [];
    const tools: ToolsHost = {
      registerContributions: async (contributions) => {
        handed.push(contributions);
      },
    };
    const kernel = await bootKernel({
      catalog: { frame } as never,
      coreRows: [{ id: "frame", plugin: "frame" }],
      files: disk.profileFiles(),
      extensions: { files: disk.extensionFiles(), modules, tools },
    });
    await kernel.loaded;
    return { kernel, handed };
  }

  test("language servers and tools of enabled extensions go to the host with an id of their own", async () => {
    const disk = new Disk();
    disk.install("sample", {
      languageServers: [
        { id: "taplo", name: "Taplo", command: "taplo", args: ["lsp", "stdio"], languageId: "toml", extensions: ["toml"], install: TAPLO_RECIPE },
        { id: "plain", command: "plain-ls", languageId: "plain", fileNames: ["PLAIN"] },
      ],
      tools: [{ id: "fmt", name: "Formatter", install: { kind: "npm", package: "fmt", binaries: ["fmt"] } }],
    });
    const { handed } = await bootWithHost(disk);
    const last = handed.at(-1)!;
    expect(last.tools.map((tool) => tool.id)).toEqual(["sample:fmt", "sample:taplo"]);
    expect(last.tools[1]).toMatchObject({ source: "sample", install: { kind: "github-release" } });
    expect(last.servers.map((server) => [server.name, server.command, server.extensions, server.fileNames])).toEqual([
      ["Taplo", "taplo", ["toml"], []],
      ["plain", "plain-ls", [], ["PLAIN"]],
    ]);
  });

  test("a disabled extension's servers and tools are taken away again", async () => {
    const disk = new Disk();
    disk.install("sample", { languageServers: [{ id: "taplo", command: "taplo", languageId: "toml", extensions: ["toml"], install: TAPLO_RECIPE }] });
    const { kernel, handed } = await bootWithHost(disk);
    expect(handed.at(-1)!.servers).toHaveLength(1);
    await kernel.extensions.setEnabled("sample", false);
    expect(handed.at(-1)).toEqual({ tools: [], servers: [], grammars: [] });
  });

  test("grammars of enabled extensions go to the host with absolute paths", async () => {
    const disk = new Disk();
    disk.install("sample", {
      grammars: [
        {
          language: "zig",
          wasm: "grammars/zig.wasm",
          highlights: "queries/highlights.scm",
          locals: "queries/locals.scm",
          extensions: ["zig"],
        },
        { language: "bare", wasm: "bare.wasm", symbol: "bare_lang", fileNames: ["BARE"] },
      ],
    });
    const { kernel, handed } = await bootWithHost(disk);
    const directory = kernel.extensions.installed()[0].directory;
    expect(handed.at(-1)!.grammars).toEqual([
      {
        language: "zig",
        wasm: `${directory}/grammars/zig.wasm`,
        highlights: `${directory}/queries/highlights.scm`,
        locals: `${directory}/queries/locals.scm`,
        extensions: ["zig"],
        fileNames: [],
      },
      { language: "bare", symbol: "bare_lang", wasm: `${directory}/bare.wasm`, extensions: [], fileNames: ["BARE"] },
    ]);
    await kernel.extensions.setEnabled("sample", false);
    expect(handed.at(-1)!.grammars).toEqual([]);
  });

  test("a recipe that does not provide the server's command is dropped with a problem", async () => {
    const disk = new Disk();
    disk.install("sample", {
      languageServers: [{ id: "taplo", command: "taplo-lsp", languageId: "toml", extensions: ["toml"], install: TAPLO_RECIPE }],
    });
    const { kernel, handed } = await bootWithHost(disk);
    expect(handed.at(-1)!.tools).toEqual([]);
    expect(handed.at(-1)!.servers).toHaveLength(1);
    expect(kernel.extensions.installed()[0].problems[0]).toContain('does not provide "taplo-lsp"');
  });

  test("a host that cannot take them is logged and the plugins still load", async () => {
    const disk = new Disk();
    disk.install("sample", STATUS_PLUGIN, { "dist/item.js": STATUS_SCRIPT });
    const kernel = await bootKernel({
      catalog: { frame } as never,
      coreRows: [{ id: "frame", plugin: "frame" }],
      files: disk.profileFiles(),
      extensions: {
        files: disk.extensionFiles(),
        modules,
        tools: {
          registerContributions: async () => {
            throw new Error("host went away");
          },
        },
      },
    });
    await kernel.loaded;
    expect(kernel.slots.entries("statusbar")).toHaveLength(1);
  });
});
