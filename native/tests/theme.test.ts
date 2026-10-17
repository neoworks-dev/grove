import { describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import { activeScheme } from "../plugins/theme/active";
import { DARK_SYNTAX, LIGHT_SYNTAX, activeEditorTheme } from "../plugins/theme/editorTheme";
import { CORE_THEMES, NEOWORKS_DARK, NEOWORKS_LIGHT } from "../plugins/theme/palette";
import { ThemeService } from "../plugins/theme/service";
import { colors, menuItemStyle, shell } from "../plugins/theme/tokens";

/** A context with the theme service and the two core themes registered by a plugin of their own. */
async function themed(): Promise<Context> {
  const context = new Context();
  await context.plugin({
    name: "theme",
    apply(ctx: Context) {
      new ThemeService(ctx);
    },
  });
  await context.plugin({
    name: "core-themes",
    inject: ["theme"],
    apply(ctx: Context) {
      for (const definition of CORE_THEMES) {
        ctx.theme.registerTheme(definition);
      }
    },
  });
  return context;
}

describe("theme service", () => {
  test("selecting a theme changes what components read through colors and styles", async () => {
    const context = await themed();
    context.theme.select("neoworks");
    expect(colors.canvas).toBe(NEOWORKS_DARK.canvas);
    expect(shell.background).toBe(NEOWORKS_DARK.canvas);
    expect(menuItemStyle()).toBeUndefined();

    context.theme.select("neoworks-light");
    expect(colors.canvas).toBe(NEOWORKS_LIGHT.canvas);
    expect(colors.text).toBe(NEOWORKS_LIGHT.text);
    expect(shell.background).toBe(NEOWORKS_LIGHT.canvas);
    expect(activeScheme()).toBe("light");
    expect(menuItemStyle()).toEqual({ color: NEOWORKS_LIGHT.text });
    expect(context.theme.activeId()).toBe("neoworks-light");
  });

  test("an accent override replaces the theme's accent until it is cleared", async () => {
    const context = await themed();
    context.theme.select("neoworks-light");
    context.theme.setAccent("#ff0000");
    expect(colors.accent).toBe("#ff0000");
    expect(colors.canvas).toBe(NEOWORKS_LIGHT.canvas);
    context.theme.setAccent("");
    expect(colors.accent).toBe(NEOWORKS_LIGHT.accent);
  });

  test("a theme that is not registered yet applies once its plugin loads", async () => {
    const context = await themed();
    context.theme.select("midnight");
    expect(context.theme.activeId()).toBe("neoworks");
    expect(colors.canvas).toBe(NEOWORKS_DARK.canvas);
    const midnight = { ...NEOWORKS_DARK, canvas: "#000011" };
    const plugin = context.plugin({
      name: "midnight",
      inject: ["theme"],
      apply(ctx: Context) {
        ctx.theme.registerTheme({ id: "midnight", name: "Midnight", scheme: "dark", tokens: midnight });
      },
    });
    await plugin;
    expect(colors.canvas).toBe("#000011");
    await plugin.dispose();
    expect(colors.canvas).toBe(NEOWORKS_DARK.canvas);
    expect(context.theme.themes().map((theme) => theme.id)).toEqual(["neoworks", "neoworks-light"]);
  });

  test("both core themes define every token", () => {
    expect(Object.keys(NEOWORKS_LIGHT).sort()).toEqual(Object.keys(NEOWORKS_DARK).sort());
  });

  test("unloading the theme plugin puts the dark palette back", async () => {
    const context = new Context();
    const fiber = context.plugin({
      name: "theme",
      apply(ctx: Context) {
        const service = new ThemeService(ctx);
        service.registerTheme(CORE_THEMES[1]);
        service.select("neoworks-light");
      },
    });
    await fiber;
    expect(colors.canvas).toBe(NEOWORKS_LIGHT.canvas);
    await fiber.dispose();
    expect(colors.canvas).toBe(NEOWORKS_DARK.canvas);
  });
});

describe("editor theme", () => {
  test("the editor's colours and syntax colours follow the active theme", async () => {
    const context = await themed();
    context.theme.select("neoworks");
    const dark = activeEditorTheme();
    expect(dark.background).toBe(NEOWORKS_DARK.surface);
    expect(dark.foreground).toBe(NEOWORKS_DARK.text);
    expect(dark.syntax).toBe(DARK_SYNTAX);

    context.theme.select("neoworks-light");
    const light = activeEditorTheme();
    expect(light.background).toBe(NEOWORKS_LIGHT.surface);
    expect(light.cursor).toBe(NEOWORKS_LIGHT.accent);
    expect(light.syntax).toBe(LIGHT_SYNTAX);
    expect(light.syntax.keyword).not.toBe(dark.syntax.keyword);
  });

  test("decoration colours come from the theme's status colours", async () => {
    const context = await themed();
    context.theme.select("neoworks");
    const dark = activeEditorTheme();
    expect(dark.error).toBe(NEOWORKS_DARK.red);
    expect(dark.warning).toBe(NEOWORKS_DARK.amber);
    expect(dark.added).toBe(NEOWORKS_DARK.green);
    expect(dark.modified).toBe(NEOWORKS_DARK.blue);
    context.theme.select("neoworks-light");
    expect(activeEditorTheme().error).toBe(NEOWORKS_LIGHT.red);
    expect(activeEditorTheme().inlay).toBe(NEOWORKS_LIGHT.muted);
  });

  test("an accent override reaches the cursor and the selection", async () => {
    const context = await themed();
    context.theme.select("neoworks");
    context.theme.setAccent("#ff0000");
    expect(activeEditorTheme().cursor).toBe("#ff0000");
    expect(activeEditorTheme().selection).toBe("#ff000040");
  });

  test("every syntax colour names a highlight the editor core knows", async () => {
    const source = await Bun.file(new URL("../editor-core/src/syntax/highlight.rs", import.meta.url)).text();
    const list = source.slice(source.indexOf("HIGHLIGHT_NAMES: &[&str]"), source.indexOf("];"));
    const known = [...list.matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]);
    for (const name of [...Object.keys(DARK_SYNTAX), ...Object.keys(LIGHT_SYNTAX)]) {
      expect(known).toContain(name);
    }
  });
});
