import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { bootKernel } from "../kernel/boot";
import type { Kernel } from "../kernel/kernel";
import type { ProfileFiles, ProfileRow, ResolvedRow } from "../kernel/profile";
import { baseValueOf, withEnabled, withFieldValue, type OverrideTarget } from "../kernel/settings/overrides";
import { defineSettings, setting } from "../kernel/settings";

const USER_PROFILE = "/config/grove/profile.json";

const clockSettings = defineSettings({
  format: setting.enum({
    label: "Format",
    default: "12h",
    options: [
      { value: "12h", label: "12 hour" },
      { value: "24h", label: "24 hour" },
    ],
  }),
  tick: setting.number({ label: "Tick", default: 1, min: 1, max: 60, live: true }),
  seconds: setting.boolean({ label: "Seconds", default: false, live: true }),
  keys: setting.keybinding({ label: "Keys", default: "ctrl+t" }),
  tint: setting.color({ label: "Tint", default: "" }),
});

describe("settings schema", () => {
  const validate = (value: unknown) => clockSettings["~standard"].validate(value) as any;

  test("fills in the defaults of fields the config leaves out", () => {
    expect(validate(undefined).value).toEqual({ format: "12h", tick: 1, seconds: false, keys: "ctrl+t", tint: "" });
    expect(validate({ tick: 5 }).value.tick).toBe(5);
  });

  test("names the field that has a wrong value", () => {
    const result = validate({ format: "36h", tick: 0, keys: "ctrl+nonsense+", tint: "red" });
    expect(result.issues.map((issue: { path: string[] }) => issue.path[0]).sort()).toEqual(["format", "keys", "tick", "tint"]);
  });

  test("passes unknown keys through", () => {
    expect(validate({ extra: 1 }).value.extra).toBe(1);
  });
});

describe("override rows", () => {
  const coreRow: ResolvedRow = { id: "clock", plugin: "clock", config: { format: "24h" }, disabled: false, layer: "core" };
  const target: OverrideTarget = { rowId: "clock", plugin: "clock", coreRow, fields: clockSettings.fields };

  test("a changed field becomes a row holding only that key, without the plugin", () => {
    expect(withFieldValue([], target, "tick", 5)).toEqual([{ id: "clock", config: { tick: 5 } }]);
  });

  test("setting a field back to what core gives drops the key and then the row", () => {
    const changed = withFieldValue([], target, "format", "12h");
    expect(changed).toEqual([{ id: "clock", config: { format: "12h" } }]);
    expect(withFieldValue(changed, target, "format", "24h")).toEqual([]);
  });

  test("a value equal to the schema default is not written when core does not set it", () => {
    expect(withFieldValue([], target, "tick", 1)).toEqual([]);
    expect(baseValueOf(target, "tick")).toBe(1);
    expect(baseValueOf(target, "format")).toBe("24h");
  });

  test("resetting removes the override and keeps the others", () => {
    const rows: ProfileRow[] = [{ id: "clock", config: { tick: 5, seconds: true } }, { id: "other", disabled: true }];
    expect(withFieldValue(rows, target, "tick", undefined)).toEqual([
      { id: "clock", config: { seconds: true } },
      { id: "other", disabled: true },
    ]);
  });

  test("disabling writes only the flag, and enabling again removes the row", () => {
    const disabled = withEnabled([], target, false);
    expect(disabled).toEqual([{ id: "clock", disabled: true }]);
    expect(withEnabled(disabled, target, true)).toEqual([]);
  });

  test("a row that core has disabled needs an explicit false to be enabled", () => {
    const disabledCore = { ...target, coreRow: { ...coreRow, disabled: true } };
    expect(withEnabled([], disabledCore, true)).toEqual([{ id: "clock", disabled: false }]);
  });

  test("a row that exists only in the user layer keeps its plugin", () => {
    const userOnly: OverrideTarget = { rowId: "extra", plugin: "clock", coreRow: undefined, fields: clockSettings.fields };
    expect(withFieldValue([{ id: "extra", plugin: "clock" }], userOnly, "tick", 3)).toEqual([
      { id: "extra", plugin: "clock", config: { tick: 3 } },
    ]);
    expect(withFieldValue([{ id: "extra", plugin: "clock", config: { tick: 3 } }], userOnly, "tick", undefined)).toEqual([
      { id: "extra", plugin: "clock" },
    ]);
  });
});

describe("SettingsService", () => {
  /** Files held in memory; `writes` records every write to the user profile. */
  function memoryFiles(userProfile: string | null, project: string | null = null) {
    const state = { userProfile, writes: [] as string[] };
    const files: ProfileFiles = {
      async readIfExists(path) {
        if (path === USER_PROFILE) {
          return state.userProfile;
        }
        if (path === "/folder/.grove/profile.json") {
          return project;
        }
        return null;
      },
      async configDirectory() {
        return "/config";
      },
      async openedFolder() {
        return "/folder";
      },
      async writeText(path, text) {
        expect(path).toBe(USER_PROFILE);
        state.userProfile = text;
        state.writes.push(text);
      },
    };
    return { files, state };
  }

  /** A clock plugin that records its mounts, unmounts and live changes. */
  function clockCatalog(events: string[]) {
    return {
      clock: {
        name: "clock",
        Config: clockSettings,
        inject: ["settings"],
        apply(ctx: Context, config: { tick: number; seconds: boolean; format: string }) {
          events.push(`on tick=${config.tick} seconds=${config.seconds} format=${config.format}`);
          ctx.effect(() => () => void events.push("off"));
          ctx.settings.onLive((change) => events.push(`live ${change.changed.join(",")} tick=${change.config.tick}`));
        },
      },
      frame: { name: "frame", essential: true, apply() {} },
    };
  }

  const coreRows = [
    { id: "frame", plugin: "frame" },
    { id: "clock", plugin: "clock", config: { format: "24h" } },
  ];

  async function boot(userProfile: string | null, project: string | null = null) {
    const events: string[] = [];
    const { files, state } = memoryFiles(userProfile, project);
    const kernel: Kernel = await bootKernel({ catalog: clockCatalog(events), coreRows, files });
    await kernel.loaded;
    return { kernel, events, state };
  }

  test("lists the rows with their schema, values and overrides", async () => {
    const { kernel } = await boot('[{"id":"clock","config":{"tick":9}}]');
    const clock = kernel.settings.entries().find((entry) => entry.rowId === "clock")!;
    expect(clock.values).toEqual({ format: "24h", tick: 9, seconds: false, keys: "ctrl+t", tint: "" });
    expect(clock.overridden).toEqual(["tick"]);
    expect(clock.status).toBe("active");
    expect(Object.keys(clock.schema!.fields)).toEqual(["format", "tick", "seconds", "keys", "tint"]);
    const frame = kernel.settings.entries().find((entry) => entry.rowId === "frame")!;
    expect(frame.schema).toBeUndefined();
    expect(frame.essential).toBe(true);
  });

  test("a live field is written as a minimal override and followed without remounting", async () => {
    const { kernel, events, state } = await boot(null);
    await kernel.settings.set("clock", "tick", 7);
    expect(JSON.parse(state.userProfile!)).toEqual([{ id: "clock", config: { tick: 7 } }]);
    expect(events).toEqual(["on tick=1 seconds=false format=24h", "live tick tick=7"]);
    expect(kernel.settings.entries().find((entry) => entry.rowId === "clock")!.values.tick).toBe(7);
  });

  test("a field that is not live mounts the plugin again with the new config", async () => {
    const { kernel, events, state } = await boot(null);
    await kernel.settings.set("clock", "format", "12h");
    expect(JSON.parse(state.userProfile!)).toEqual([{ id: "clock", config: { format: "12h" } }]);
    expect(events).toEqual(["on tick=1 seconds=false format=24h", "off", "on tick=1 seconds=false format=12h"]);
  });

  test("a later live change after a remount is still followed", async () => {
    const { kernel, events } = await boot(null);
    await kernel.settings.set("clock", "format", "12h");
    await kernel.settings.set("clock", "seconds", true);
    expect(events[events.length - 1]).toBe("live seconds tick=1");
  });

  test("changing one plugin leaves the others mounted", async () => {
    const { kernel } = await boot(null);
    await kernel.settings.set("clock", "format", "12h");
    const frame = kernel.loader.reports().find((report) => report.id === "frame")!;
    expect(frame.status).toBe("active");
  });

  test("disabling a row unloads its plugin and enabling removes the override", async () => {
    const { kernel, events, state } = await boot(null);
    await kernel.settings.setEnabled("clock", false);
    expect(JSON.parse(state.userProfile!)).toEqual([{ id: "clock", disabled: true }]);
    expect(events).toEqual(["on tick=1 seconds=false format=24h", "off"]);
    expect(kernel.loader.reports().find((report) => report.id === "clock")!.status).toBe("disabled");
    await kernel.settings.setEnabled("clock", true);
    expect(JSON.parse(state.userProfile!)).toEqual([]);
    expect(events[events.length - 1]).toBe("on tick=1 seconds=false format=24h");
  });

  test("reset takes a field back to core's value", async () => {
    const { kernel, state } = await boot('[{"id":"clock","config":{"format":"12h","tick":4}}]');
    await kernel.settings.reset("clock", "format");
    expect(JSON.parse(state.userProfile!)).toEqual([{ id: "clock", config: { tick: 4 } }]);
  });

  test("refuses a value the schema does not accept and writes nothing", async () => {
    const { kernel, state } = await boot(null);
    await expect(kernel.settings.set("clock", "tick", 0)).rejects.toThrow("Tick must be at least 1");
    await expect(kernel.settings.set("clock", "nope", 1)).rejects.toThrow("no setting named");
    expect(state.writes).toEqual([]);
  });

  test("leaves a user file it cannot read alone", async () => {
    const { kernel, state } = await boot("{broken");
    await expect(kernel.settings.set("clock", "tick", 3)).rejects.toThrow("left alone");
    expect(state.writes).toEqual([]);
  });

  test("keeps the other rows of the user's file when it writes", async () => {
    const { kernel, state } = await boot('[{"id":"frame","config":{"x":1}},{"id":"mine","plugin":"clock"}]');
    await kernel.settings.set("clock", "tick", 2);
    expect(JSON.parse(state.userProfile!)).toEqual([
      { id: "frame", config: { x: 1 } },
      { id: "mine", plugin: "clock" },
      { id: "clock", config: { tick: 2 } },
    ]);
  });

  test("a project layer above the user's still wins over what is written", async () => {
    const { kernel } = await boot(null, '[{"id":"clock","config":{"format":"12h"}}]');
    await kernel.settings.set("clock", "tick", 2);
    const clock = kernel.settings.entries().find((entry) => entry.rowId === "clock")!;
    expect(clock.values.format).toBe("12h");
    expect(clock.values.tick).toBe(2);
  });

  test("simultaneous changes are written one after the other and none is lost", async () => {
    const { kernel, state } = await boot(null);
    await Promise.all([kernel.settings.set("clock", "tick", 2), kernel.settings.set("clock", "seconds", true)]);
    expect(JSON.parse(state.userProfile!)).toEqual([{ id: "clock", config: { tick: 2, seconds: true } }]);
  });
});
