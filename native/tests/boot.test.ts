import { describe, expect, test } from "bun:test";
import type { Context } from "@neoworks/extension-system";
import { bootKernel } from "../kernel/boot";
import type { ProfileFiles } from "../kernel/profile";
import type { SlotEntry } from "../kernel/slots";

const component = (() => {}) as unknown as SlotEntry["component"];

/** Files held in memory, with a user profile and an opened folder that has none. */
function files(userProfile: string | null): ProfileFiles {
  return {
    async readIfExists(path) {
      if (path === "/config/grove/profile.json") {
        return userProfile;
      }
      return null;
    },
    async configDirectory() {
      return "/config";
    },
    async openedFolder() {
      return "/folder";
    },
    async writeText() {},
  };
}

/** Two plugins: a frame that declares a list slot, and a contributor that fills it. */
const catalog = {
  frame: {
    name: "frame",
    inject: ["slots"],
    apply(ctx: Context) {
      ctx.slots.declare("statusbar", "list");
    },
  },
  clock: {
    name: "clock",
    inject: ["slots"],
    apply(ctx: Context) {
      ctx.slots.register("statusbar", { id: "clock", component });
    },
  },
};

const coreRows = [
  { id: "frame", plugin: "frame" },
  { id: "clock", plugin: "clock" },
];

describe("bootKernel", () => {
  test("loads the core rows and fills the slots they declare", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files(null) });
    await kernel.loaded;
    expect(kernel.loader.reports().map((report) => report.status)).toEqual(["active", "active"]);
    expect(kernel.slots.entries("statusbar").map((entry) => entry.id)).toEqual(["clock"]);
  });

  test("a user row disables a core plugin by id and its entry disappears", async () => {
    const kernel = await bootKernel({
      catalog,
      coreRows,
      files: files('[{"id":"clock","disabled":true}]'),
    });
    await kernel.loaded;
    expect(kernel.slots.entries("statusbar")).toEqual([]);
    expect(kernel.loader.reports().find((report) => report.id === "clock")?.status).toBe("disabled");
  });

  test("a broken user file is logged and the core profile still loads", async () => {
    const kernel = await bootKernel({ catalog, coreRows, files: files("{nope") });
    await kernel.loaded;
    expect(kernel.slots.entries("statusbar")).toHaveLength(1);
  });
});
