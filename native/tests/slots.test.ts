import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { SlotRegistry, type SlotEntry } from "../kernel/slots/registry";
import { SlotsService } from "../kernel/slots/service";

const component = (() => {}) as unknown as SlotEntry["component"];

/** An entry with the given fields over a stub component. */
function entry(fields: Partial<SlotEntry> & { id: string }): SlotEntry {
  return { component, ...fields };
}

describe("SlotRegistry", () => {
  test("declaring a slot twice throws, naming the owner", () => {
    const registry = new SlotRegistry();
    registry.declare("header", "single", "frame");
    expect(() => registry.declare("header", "single", "other")).toThrow('slot "header" is already declared by frame');
  });

  test("entries registered before the declaration wait for it", () => {
    const registry = new SlotRegistry();
    registry.register("statusbar", entry({ id: "clock" }), "clock");
    expect(registry.resolve("statusbar")).toEqual([]);
    registry.declare("statusbar", "list", "frame");
    expect(registry.resolve("statusbar").map((candidate) => candidate.id)).toEqual(["clock"]);
  });

  test("a list slot orders entries by order, then by registration", () => {
    const registry = new SlotRegistry();
    registry.declare("statusbar", "list", "frame");
    registry.register("statusbar", entry({ id: "c", order: 20 }), "a");
    registry.register("statusbar", entry({ id: "a", order: 10 }), "a");
    registry.register("statusbar", entry({ id: "b", order: 10 }), "a");
    registry.register("statusbar", entry({ id: "d" }), "a");
    expect(registry.resolve("statusbar").map((candidate) => candidate.id)).toEqual(["d", "a", "b", "c"]);
  });

  test("a single slot renders its lowest priority entry", () => {
    const registry = new SlotRegistry();
    registry.declare("header", "single", "frame");
    registry.register("header", entry({ id: "default" }), "shell");
    registry.register("header", entry({ id: "override", priority: 50 }), "theme");
    registry.register("header", entry({ id: "late", priority: 200 }), "late");
    expect(registry.resolve("header").map((candidate) => candidate.id)).toEqual(["override"]);
  });

  test("two entries at the same priority in a single slot throw, naming the occupant", () => {
    const registry = new SlotRegistry();
    registry.declare("header", "single", "frame");
    registry.register("header", entry({ id: "first" }), "shell");
    expect(() => registry.register("header", entry({ id: "second" }), "theme")).toThrow(
      'slot "header" already has "first" from shell at priority 100'
    );
  });

  test("a keyed slot holds one entry per key", () => {
    const registry = new SlotRegistry();
    registry.declare("main", "keyed", "frame");
    registry.register("main", entry({ id: "editor", key: "editor" }), "editor");
    registry.register("main", entry({ id: "agents", key: "agents" }), "agents");
    registry.register("main", entry({ id: "editor-override", key: "editor", priority: 10 }), "theme");
    const ids = registry.resolve("main").map((candidate) => candidate.id);
    expect(ids.sort()).toEqual(["agents", "editor-override"]);
    expect(() => registry.register("main", entry({ id: "again", key: "agents" }), "other")).toThrow(
      'already has "agents" from agents'
    );
  });

  test("a keyed entry without a key is refused", () => {
    const registry = new SlotRegistry();
    registry.declare("main", "keyed", "frame");
    expect(() => registry.register("main", entry({ id: "lost" }), "plugin")).toThrow("needs a key");
  });

  test("a clash among waiting entries drops the later one when the slot is declared", () => {
    const registry = new SlotRegistry();
    registry.register("header", entry({ id: "first" }), "shell");
    registry.register("header", entry({ id: "second" }), "theme");
    const { rejected } = registry.declare("header", "single", "frame");
    expect(rejected.map((item) => item.entry.id)).toEqual(["second"]);
    expect(registry.resolve("header").map((candidate) => candidate.id)).toEqual(["first"]);
  });

  test("removing an entry reveals the one it shadowed", () => {
    const registry = new SlotRegistry();
    registry.declare("header", "single", "frame");
    registry.register("header", entry({ id: "default" }), "shell");
    const removeOverride = registry.register("header", entry({ id: "override", priority: 1 }), "theme");
    expect(registry.resolve("header")[0].id).toBe("override");
    removeOverride();
    expect(registry.resolve("header")[0].id).toBe("default");
  });
});

describe("SlotsService", () => {
  /** A root context with the slots service mounted. */
  async function bootedContext(): Promise<Context> {
    const context = new Context();
    await context.plugin(SlotsService);
    return context;
  }

  test("a plugin's declarations and entries leave when the plugin is disposed", async () => {
    const context = await bootedContext();
    const frame = (ctx: Context) => {
      ctx.slots.declare("statusbar", "list");
    };
    frame.inject = ["slots"];
    const contributor = (ctx: Context) => {
      ctx.slots.register("statusbar", entry({ id: "clock" }));
    };
    contributor.inject = ["slots"];

    const frameFiber = context.plugin(frame);
    const contributorFiber = context.plugin(contributor);
    await frameFiber;
    await contributorFiber;
    expect(context.slots.entries("statusbar").map((candidate) => candidate.id)).toEqual(["clock"]);

    await contributorFiber.dispose();
    expect(context.slots.entries("statusbar")).toEqual([]);

    const again = context.plugin(contributor);
    await again;
    expect(context.slots.entries("statusbar")).toHaveLength(1);
    await frameFiber.dispose();
    expect(context.slots.isDeclared("statusbar")).toBe(false);
    expect(context.slots.entries("statusbar")).toEqual([]);
  });

  test("declaring a slot twice fails the second plugin and leaves the first working", async () => {
    const context = await bootedContext();
    const first = (ctx: Context) => {
      ctx.slots.declare("header", "single");
    };
    first.inject = ["slots"];
    const second = (ctx: Context) => {
      ctx.slots.declare("header", "single");
    };
    second.inject = ["slots"];
    await context.plugin(first);
    const mountSecond = async () => {
      await context.plugin(second);
    };
    await expect(mountSecond()).rejects.toThrow('slot "header" is already declared by');
    expect(context.slots.isDeclared("header")).toBe(true);
  });

  test("an entry waits for a declaration that a later plugin makes", async () => {
    const context = await bootedContext();
    const contributor = (ctx: Context) => {
      ctx.slots.register("overlay", entry({ id: "toast" }));
    };
    contributor.inject = ["slots"];
    await context.plugin(contributor);
    expect(context.slots.entries("overlay")).toEqual([]);

    const owner = (ctx: Context) => {
      ctx.slots.declare("overlay", "list");
    };
    owner.inject = ["slots"];
    await context.plugin(owner);
    expect(context.slots.entries("overlay").map((candidate) => candidate.id)).toEqual(["toast"]);
  });

  test("the root slot is declared by the kernel", async () => {
    const context = await bootedContext();
    expect(context.slots.isDeclared("root")).toBe(true);
  });
});
