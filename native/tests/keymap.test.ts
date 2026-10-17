import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands/service";
import { KeyPriority, type KeyEventInput } from "../kernel/keymap/keyDispatch";
import { findConflicts, formatSequence, parseSequence, stepFromEvent } from "../kernel/keymap/keySequence";
import { KeymapService } from "../kernel/keymap/service";

interface PressedKey extends KeyEventInput {
  prevented: boolean;
}

/** A window key event as svelte-gpui delivers it, with the modifiers named by the DOM. */
function press(key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): PressedKey {
  const event: PressedKey = {
    key,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: modifiers.shift === true,
    metaKey: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

/** A root context with commands and the keymap mounted, and a command that records its runs. */
async function bootedContext(): Promise<{ context: Context; ran: string[] }> {
  const context = new Context();
  await context.plugin(CommandsService);
  await context.plugin(KeymapService);
  const ran: string[] = [];
  for (const id of ["save", "open", "find"]) {
    context.commands.register({ id, title: id, run: () => void ran.push(id) });
  }
  return { context, ran };
}

/** Lets a command that `run` started finish. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("key sequences", () => {
  test("parse and format round trip", () => {
    const parsed = parseSequence("ctrl+k ctrl+s");
    expect(parsed?.steps).toHaveLength(2);
    expect(formatSequence(parsed!)).toBe("<Ctrl-K> <Ctrl-S>");
  });

  test("a gpui window event becomes the canonical step", () => {
    expect(stepFromEvent(press("ArrowLeft", { ctrl: true }))).toEqual({
      key: "left",
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    expect(stepFromEvent(press("F2")).key).toBe("f2");
  });

  test("invalid sequences do not parse", () => {
    expect(parseSequence("ctrl+")).toBeNull();
    expect(parseSequence("")).toBeNull();
  });

  test("duplicate and shadowing bindings are found", () => {
    const sequence = (text: string) => parseSequence(text)!;
    const conflicts = findConflicts([
      { id: "a", sequence: sequence("ctrl+k") },
      { id: "b", sequence: sequence("ctrl+k ctrl+s") },
      { id: "c", sequence: sequence("ctrl+k") },
    ]);
    expect(conflicts.map((conflict) => [conflict.firstId, conflict.secondId, conflict.kind])).toEqual([
      ["a", "b", "shadow"],
      ["a", "c", "duplicate"],
      ["b", "c", "shadow"],
    ]);
  });
});

describe("KeymapService", () => {
  test("a chord runs its command and takes the key", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "save", keys: "ctrl+s", command: "save" });
    const event = press("s", { ctrl: true });
    expect(context.keymap.dispatch(event)).toBe(true);
    expect(event.prevented).toBe(true);
    await settle();
    expect(ran).toEqual(["save"]);
  });

  test("a multi-key sequence runs on its last key and not before", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "open", keys: "ctrl+k f2", command: "open" });
    expect(context.keymap.dispatch(press("k", { ctrl: true }))).toBe(true);
    expect(context.keymap.pendingSteps()).toHaveLength(1);
    await settle();
    expect(ran).toEqual([]);
    expect(context.keymap.dispatch(press("F2"))).toBe(true);
    expect(context.keymap.pendingSteps()).toHaveLength(0);
    await settle();
    expect(ran).toEqual(["open"]);
  });

  test("nextKeys lists what can finish a half-typed sequence, once per key", async () => {
    const { context } = await bootedContext();
    context.keymap.bind([
      { id: "open", keys: "ctrl+k f2", command: "open", description: "Open" },
      { id: "find", keys: "ctrl+k f3", command: "find", description: "Find" },
      { id: "save", keys: "ctrl+k ctrl+s", command: "save", description: "Save" },
      { id: "deep", keys: "ctrl+k f5 f6", command: "save", description: "Deep" },
    ]);
    expect(context.keymap.nextKeys()).toEqual([]);
    context.keymap.dispatch(press("k", { ctrl: true }));
    expect(context.keymap.nextKeys()).toEqual([
      { key: "F2", description: "Open", continues: false },
      { key: "F3", description: "Find", continues: false },
      { key: "Ctrl+s", description: "Save", continues: false },
      { key: "F5", description: undefined, continues: true },
    ]);
    context.keymap.dispatch(press("Escape"));
    expect(context.keymap.nextKeys()).toEqual([]);
  });

  test("a wrong second key ends the sequence without running anything", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "open", keys: "ctrl+k f2", command: "open" });
    context.keymap.dispatch(press("k", { ctrl: true }));
    expect(context.keymap.dispatch(press("F3"))).toBe(true);
    expect(context.keymap.pendingSteps()).toHaveLength(0);
    await settle();
    expect(ran).toEqual([]);
  });

  test("escape aborts a sequence", async () => {
    const { context } = await bootedContext();
    context.keymap.bind({ id: "open", keys: "ctrl+k f2", command: "open" });
    context.keymap.dispatch(press("k", { ctrl: true }));
    expect(context.keymap.dispatch(press("Escape"))).toBe(true);
    expect(context.keymap.pendingSteps()).toHaveLength(0);
  });

  test("a key with no binding is left alone", async () => {
    const { context } = await bootedContext();
    context.keymap.bind({ id: "save", keys: "ctrl+s", command: "save" });
    const event = press("q", { ctrl: true });
    expect(context.keymap.dispatch(event)).toBe(false);
    expect(event.prevented).toBe(false);
  });

  test("bare keys wait until a plugin says nothing is typing", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "find", keys: "f", command: "find" });
    expect(context.keymap.dispatch(press("f"))).toBe(false);
    let typing = true;
    context.keymap.allowBareKeys(() => !typing);
    expect(context.keymap.dispatch(press("f"))).toBe(false);
    typing = false;
    expect(context.keymap.dispatch(press("f"))).toBe(true);
    await settle();
    expect(ran).toEqual(["find"]);
  });

  test("a leader sequence starts on space once bare keys are allowed", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "find", keys: "leader f f", command: "find" });
    expect(context.keymap.dispatch(press(" "))).toBe(false);
    context.keymap.allowBareKeys(() => true);
    expect(context.keymap.dispatch(press(" "))).toBe(true);
    context.keymap.dispatch(press("f"));
    context.keymap.dispatch(press("f"));
    await settle();
    expect(ran).toEqual(["find"]);
  });

  test("a binding for a command that cannot run does not take the key", async () => {
    const { context } = await bootedContext();
    context.keymap.bind({ id: "ghost", keys: "ctrl+g", command: "no.such.command" });
    expect(context.keymap.dispatch(press("g", { ctrl: true }))).toBe(false);
  });

  test("a binding's when decides whether it applies", async () => {
    const { context, ran } = await bootedContext();
    let enabled = false;
    context.keymap.bind({ id: "save", keys: "ctrl+s", command: "save", when: () => enabled });
    expect(context.keymap.dispatch(press("s", { ctrl: true }))).toBe(false);
    enabled = true;
    expect(context.keymap.dispatch(press("s", { ctrl: true }))).toBe(true);
    await settle();
    expect(ran).toEqual(["save"]);
  });

  test("a binding for a context beats one for everywhere on the same keys, whichever came first", async () => {
    const { context, ran } = await bootedContext();
    let inContext = false;
    context.keymap.bind({ id: "everywhere", keys: "ctrl+o", command: "open" });
    context.keymap.bind({ id: "here", keys: "ctrl+o", command: "find", when: () => inContext });
    expect(context.keymap.dispatch(press("o", { ctrl: true }))).toBe(true);
    inContext = true;
    expect(context.keymap.dispatch(press("o", { ctrl: true }))).toBe(true);
    await settle();
    expect(ran).toEqual(["open", "find"]);
  });

  test("a rebind layer changes keys and null unbinds", async () => {
    const { context } = await bootedContext();
    context.keymap.bind([
      { id: "save", keys: "ctrl+s", command: "save" },
      { id: "open", keys: "ctrl+o", command: "open" },
    ]);
    const undo = context.keymap.rebind({ save: "ctrl+shift+s", open: null });
    expect(context.keymap.dispatch(press("s", { ctrl: true }))).toBe(false);
    expect(context.keymap.dispatch(press("o", { ctrl: true }))).toBe(false);
    expect(context.keymap.dispatch(press("S", { ctrl: true, shift: true }))).toBe(true);
    undo();
    expect(context.keymap.dispatch(press("o", { ctrl: true }))).toBe(true);
  });

  test("bindings leave with the plugin that added them", async () => {
    const { context } = await bootedContext();
    const plugin = (ctx: Context) => {
      ctx.keymap.bind({ id: "save", keys: "ctrl+s", command: "save" });
    };
    plugin.inject = ["keymap"];
    const fiber = context.plugin(plugin);
    await fiber;
    expect(context.keymap.effective()).toHaveLength(1);
    await fiber.dispose();
    expect(context.keymap.effective()).toHaveLength(0);
  });

  test("a subscriber at a higher tier claims a key before the bindings", async () => {
    const { context, ran } = await bootedContext();
    context.keymap.bind({ id: "save", keys: "ctrl+s", command: "save" });
    context.keymap.subscribe(KeyPriority.overlay, () => true);
    expect(context.keymap.dispatch(press("s", { ctrl: true }))).toBe(true);
    await settle();
    expect(ran).toEqual([]);
  });

  test("keysFor gives keycap labels", async () => {
    const { context } = await bootedContext();
    context.keymap.bind({ id: "open", keys: "ctrl+k f2", command: "open" });
    expect(context.keymap.keysFor("open")).toEqual(["Ctrl+k", "F2"]);
    expect(context.keymap.keysFor("save")).toEqual([]);
  });
});
