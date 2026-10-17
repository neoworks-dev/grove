import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { LoaderService } from "../kernel/profile/loader";
import { layerProfiles, parseProfile } from "../kernel/profile/rows";
import { loadProfile, type ProfileFiles } from "../kernel/profile/sources";

describe("parseProfile", () => {
  test("reads an array of rows", () => {
    const parsed = parseProfile('[{"id":"a","plugin":"p","config":{"x":1}},{"id":"b","plugin":"q","disabled":true}]', "f");
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
  });

  test("reports bad JSON, a non-array and bad rows without throwing", () => {
    expect(parseProfile("{", "f").problems[0]).toContain("not valid JSON");
    expect(parseProfile("{}", "f").problems[0]).toContain("expected a JSON array");
    const parsed = parseProfile('[{"id":"a","plugin":"p"},{"plugin":"q"},3,{"id":"c","disabled":"yes"}]', "f");
    expect(parsed.rows.map((row) => row.id)).toEqual(["a"]);
    expect(parsed.problems).toHaveLength(3);
  });
});

describe("layerProfiles", () => {
  test("a later layer replaces a row by id and keeps its position", () => {
    const { rows } = layerProfiles([
      { name: "core", rows: [{ id: "a", plugin: "one" }, { id: "b", plugin: "two", config: { size: 1 } }] },
      { name: "user", rows: [{ id: "b", plugin: "two", config: { size: 2 } }, { id: "c", plugin: "three" }] },
      { name: "project", rows: [{ id: "a", plugin: "uno" }] },
    ]);
    expect(rows.map((row) => [row.id, row.plugin, row.layer])).toEqual([
      ["a", "uno", "project"],
      ["b", "two", "user"],
      ["c", "three", "user"],
    ]);
    expect(rows[1].config).toEqual({ size: 2 });
  });

  test("a row inherits what it leaves out and merges its config over the row it replaces", () => {
    const { rows } = layerProfiles([
      { name: "core", rows: [{ id: "a", plugin: "one", config: { size: 1, color: "red" }, disabled: true }] },
      { name: "user", rows: [{ id: "a", config: { size: 2 } }] },
    ]);
    expect(rows).toEqual([
      { id: "a", plugin: "one", config: { size: 2, color: "red" }, disabled: true, layer: "user" },
    ]);
  });

  test("a disabling row without a plugin keeps the plugin of the row it replaces", () => {
    const { rows, problems } = layerProfiles([
      { name: "core", rows: [{ id: "a", plugin: "one" }] },
      { name: "user", rows: [{ id: "a", disabled: true }, { id: "ghost", disabled: true }] },
    ]);
    expect(rows).toEqual([{ id: "a", plugin: "one", config: undefined, disabled: true, layer: "user" }]);
    expect(problems).toEqual(['user: row "ghost" names no plugin']);
  });
});

describe("loadProfile", () => {
  /** Files held in memory, with the config directory and the opened folder given. */
  function memoryFiles(contents: Record<string, string>, folder: string | null): ProfileFiles {
    return {
      async readIfExists(path) {
        if (path in contents) {
          return contents[path];
        }
        return null;
      },
      async configDirectory() {
        return "/config";
      },
      async openedFolder() {
        return folder;
      },
      async writeText() {},
    };
  }

  const coreRows = [
    { id: "frame", plugin: "frame" },
    { id: "clock", plugin: "clock" },
  ];

  test("stacks core, user and project", async () => {
    const files = memoryFiles(
      {
        "/config/grove/profile.json": '[{"id":"clock","disabled":true}]',
        "/work/.grove/profile.json": '[{"id":"clock","plugin":"clock","disabled":false,"config":{"format":"24h"}}]',
      },
      "/work"
    );
    const { rows, problems } = await loadProfile(coreRows, files);
    expect(problems).toEqual([]);
    const clock = rows.find((row) => row.id === "clock")!;
    expect(clock.layer).toBe("project");
    expect(clock.disabled).toBe(false);
    expect(clock.config).toEqual({ format: "24h" });
  });

  test("skips the project layer when no folder is open", async () => {
    const files = memoryFiles(
      { "/work/.grove/profile.json": '[{"id":"clock","disabled":true}]', "/config/grove/profile.json": "[]" },
      null
    );
    const { rows } = await loadProfile(coreRows, files);
    expect(rows.find((row) => row.id === "clock")!.disabled).toBe(false);
  });

  test("a broken user file is a problem, and the core rows still load", async () => {
    const files = memoryFiles({ "/config/grove/profile.json": "not json" }, null);
    const { rows, problems } = await loadProfile(coreRows, files);
    expect(rows.map((row) => row.id)).toEqual(["frame", "clock"]);
    expect(problems[0]).toContain("not valid JSON");
  });
});

describe("LoaderService", () => {
  /** A plugin that records that it ran, and one that fails. */
  function catalogWith(events: string[]) {
    const good = (ctx: Context) => {
      events.push("good on");
      ctx.effect(() => () => void events.push("good off"));
    };
    const bad = () => {
      throw new Error("bad plugin");
    };
    return { good, bad };
  }

  async function loaderContext(catalog: Record<string, any>): Promise<Context> {
    const context = new Context();
    await context.plugin(LoaderService, catalog);
    return context;
  }

  test("a failing plugin is reported as failed and the others still load", async () => {
    const events: string[] = [];
    const context = await loaderContext(catalogWith(events));
    await context.loader.apply([
      { id: "one", plugin: "good", disabled: false, layer: "core" },
      { id: "two", plugin: "bad", disabled: false, layer: "core" },
      { id: "three", plugin: "missing", disabled: false, layer: "core" },
    ]);
    const statuses = Object.fromEntries(context.loader.reports().map((report) => [report.id, report.status]));
    expect(statuses).toEqual({ one: "active", two: "failed", three: "failed" });
    expect(context.loader.failures().map((report) => report.message)).toEqual([
      "bad plugin",
      'no core plugin named "missing"',
    ]);
    expect(events).toEqual(["good on"]);
  });

  test("disabling a row on a later apply unloads its plugin", async () => {
    const events: string[] = [];
    const context = await loaderContext(catalogWith(events));
    const row = { id: "one", plugin: "good", disabled: false, layer: "core" };
    await context.loader.apply([row]);
    await context.loader.apply([{ ...row, disabled: true, layer: "user" }]);
    expect(events).toEqual(["good on", "good off"]);
    expect(context.loader.reports()[0].status).toBe("disabled");
  });

  test("an unchanged row stays mounted across applies", async () => {
    const events: string[] = [];
    const context = await loaderContext(catalogWith(events));
    const row = { id: "one", plugin: "good", disabled: false, layer: "core" };
    await context.loader.apply([row]);
    await context.loader.apply([{ ...row }]);
    expect(events).toEqual(["good on"]);
  });

  test("a plugin waiting for a service is reported as waiting, then active when it appears", async () => {
    const context = await loaderContext({
      needy: Object.assign(() => {}, { inject: ["later"] }),
    });
    await context.loader.apply([{ id: "needy", plugin: "needy", disabled: false, layer: "core" }]);
    expect(context.loader.reports()[0].status).toBe("waiting");
    expect(context.loader.reports()[0].message).toBe("waiting for later");
    context.provide("later", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(context.loader.reports()[0].status).toBe("active");
  });
});
