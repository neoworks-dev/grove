import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { CommandsService } from "../kernel/commands";
import { KeymapService } from "../kernel/keymap";
import { matchScore, rankItems } from "../plugins/palette/fuzzy";
import { PaletteService } from "../plugins/palette/service";

describe("palette ranking", () => {
  const titles = ["Toggle sidebar", "Toggle bottom panel", "Split right", "Open settings", "Select color theme"];
  const items = titles.map((title) => ({ title }));
  const rank = (query: string) => rankItems(items, query).map((item) => item.title);

  test("an empty query keeps every item in its order", () => {
    expect(rank("")).toEqual(titles);
    expect(rank("   ")).toEqual(titles);
  });

  test("every word of the query has to match, in any order", () => {
    expect(rank("sidebar toggle")).toEqual(["Toggle sidebar"]);
    expect(rank("toggle")).toEqual(["Toggle sidebar", "Toggle bottom panel"]);
  });

  test("letters in order match across words, so initials find a command", () => {
    expect(rank("tgsb")).toEqual(["Toggle sidebar"]);
    expect(rank("scth")).toEqual(["Select color theme"]);
    expect(rank("zzz")).toEqual([]);
  });

  test("the title outranks the same word in the extra text, and a prefix outranks the middle of a word", () => {
    const ranked = rankItems(
      [
        { title: "Run task", extra: "view settings" },
        { title: "Open settings" },
        { title: "Reset settings" },
      ],
      "settings",
    );
    expect(ranked.map((item) => item.title)).toEqual(["Open settings", "Reset settings", "Run task"]);
    expect(rankItems([{ title: "Preferences" }, { title: "Reference" }], "ref").map((item) => item.title)).toEqual([
      "Reference",
      "Preferences",
    ]);
  });

  test("a scattered match never outranks the word typed in full", () => {
    const scattered = matchScore("save", { title: "Show all vertical edges" })!;
    const full = matchScore("save", { title: "Save file" })!;
    expect(full).toBeGreaterThan(scattered);
  });

  test("matching ignores case and keeps the extra text searchable", () => {
    expect(rankItems([{ title: "Quit", extra: "App exit" }], "EXIT")).toHaveLength(1);
  });
});

describe("palette service", () => {
  async function paletteContext(): Promise<{ context: Context; ran: string[] }> {
    const ran: string[] = [];
    const context = new Context();
    await context.plugin(CommandsService);
    await context.plugin(KeymapService);
    await context.plugin({
      name: "palette",
      inject: ["commands", "keymap"],
      apply(ctx: Context) {
        new PaletteService(ctx);
        ctx.commands.register({ id: "b.second", title: "Second", group: "B", run: () => void ran.push("second") });
        ctx.commands.register({ id: "a.first", title: "First", group: "A", run: () => void ran.push("first") });
        ctx.commands.register({ id: "a.hidden", title: "Hidden", group: "A", when: () => false, run: () => {} });
        ctx.keymap.bind({ id: "a.first", keys: "ctrl+shift+f", command: "a.first" });
      },
    });
    return { context, ran };
  }

  test("lists the commands that can run, by group, with their keys", async () => {
    const { context } = await paletteContext();
    context.palette.open();
    const items = context.palette.itemsFor(context.palette.session()!);
    expect(items.map((item) => item.id)).toEqual(["a.first", "b.second"]);
    expect(items[0].keys).toEqual(["Ctrl+⇧f"]);
    expect(items[1].keys).toEqual([]);
  });

  test("choosing a command closes the palette and runs it", async () => {
    const { context, ran } = await paletteContext();
    context.palette.open();
    const [first] = context.palette.itemsFor(context.palette.session()!);
    context.palette.choose(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.palette.isOpen()).toBe(false);
    expect(ran).toEqual(["first"]);
  });

  test("toggle opens and closes", async () => {
    const { context } = await paletteContext();
    context.palette.toggle();
    expect(context.palette.isOpen()).toBe(true);
    context.palette.toggle();
    expect(context.palette.isOpen()).toBe(false);
  });

  test("a picker resolves with the chosen item, or nothing when dismissed", async () => {
    const { context } = await paletteContext();
    const items = [{ id: "x", title: "X" }, { id: "y", title: "Y" }];
    const chosen = context.palette.pick(items, { placeholder: "Pick" });
    expect(context.palette.session()!.placeholder).toBe("Pick");
    context.palette.choose(items[1]);
    expect((await chosen)!.id).toBe("y");

    const dismissed = context.palette.pick(items);
    context.palette.close();
    expect(await dismissed).toBeUndefined();

    const replaced = context.palette.pick(items);
    context.palette.open();
    expect(await replaced).toBeUndefined();
  });
});
