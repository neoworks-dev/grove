import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands/service";

async function bootedContext(): Promise<Context> {
  const context = new Context();
  await context.plugin(CommandsService);
  return context;
}

describe("CommandsService", () => {
  test("runs a registered command with its arguments", async () => {
    const context = await bootedContext();
    const calls: unknown[][] = [];
    context.commands.register({ id: "demo.run", title: "Run", run: (...args) => void calls.push(args) });
    expect(await context.commands.run("demo.run", 1, "two")).toBe(true);
    expect(calls).toEqual([[1, "two"]]);
  });

  test("a command whose when says no does not run", async () => {
    const context = await bootedContext();
    let ran = false;
    context.commands.register({ id: "demo.off", title: "Off", when: () => false, run: () => void (ran = true) });
    expect(context.commands.canRun("demo.off")).toBe(false);
    expect(await context.commands.run("demo.off")).toBe(false);
    expect(ran).toBe(false);
  });

  test("a throwing command is reported as not run instead of throwing", async () => {
    const context = await bootedContext();
    context.commands.register({
      id: "demo.throw",
      title: "Throw",
      run: () => {
        throw new Error("nope");
      },
    });
    expect(await context.commands.run("demo.throw")).toBe(false);
  });

  test("an unknown command resolves to false", async () => {
    const context = await bootedContext();
    expect(await context.commands.run("nothing.here")).toBe(false);
  });

  test("commands registered by a plugin go away with it", async () => {
    const context = await bootedContext();
    const plugin = (ctx: Context) => {
      ctx.commands.register({ id: "demo.run", title: "Run", run: () => {} });
    };
    plugin.inject = ["commands"];
    const fiber = context.plugin(plugin);
    await fiber;
    expect(context.commands.list().map((command) => command.id)).toEqual(["demo.run"]);
    await fiber.dispose();
    expect(context.commands.list()).toEqual([]);
  });
});
