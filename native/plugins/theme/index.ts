// The theme plugins. `theme` provides the service and the settings that choose the theme and
// the accent, both live. `core-themes` registers Grove's two palettes, so a profile can drop
// them and keep the service. `theme-picker` adds the `theme.select` command, which lists the
// themes in the palette and writes the choice into the profile.

import type { Context } from "@neoworks/extension-system";
import { defineSettings, setting } from "../../kernel/settings";
import { CORE_THEMES, DEFAULT_THEME_ID } from "./palette";
import { ThemeService } from "./service";

export const themeSettings = defineSettings({
  theme: setting.enum({
    label: "Color theme",
    description: "The palette the whole shell is drawn with.",
    default: DEFAULT_THEME_ID,
    options: "themes",
    live: true,
  }),
  accent: setting.color({
    label: "Accent colour",
    description: "Replaces the theme's accent, as #rrggbb. Empty keeps the theme's own.",
    default: "",
    live: true,
  }),
});

export const theme = {
  name: "theme",
  Config: themeSettings,
  inject: ["settings"],
  apply(ctx: Context, config: { theme: string; accent: string }) {
    const service = new ThemeService(ctx);
    service.select(config.theme);
    service.setAccent(config.accent);
    ctx.settings.onLive((change) => {
      service.select(change.config.theme as string);
      service.setAccent(change.config.accent as string);
    });
    ctx.settings.registerOptions("themes", () =>
      service.themes().map((definition) => ({ value: definition.id, label: definition.name })),
    );
  },
};

export const coreThemes = {
  name: "core-themes",
  inject: ["theme"],
  apply(ctx: Context) {
    for (const definition of CORE_THEMES) {
      ctx.theme.registerTheme(definition);
    }
  },
};

export const themePicker = {
  name: "theme-picker",
  inject: ["theme", "settings", "palette", "commands"],
  apply(ctx: Context) {
    ctx.commands.register({
      id: "theme.select",
      title: "Select color theme",
      group: "View",
      keywords: "appearance dark light",
      run: () => pickTheme(ctx),
    });
  },
};

/** Asks which theme to use in the palette and saves the answer as the theme plugin's setting. */
async function pickTheme(ctx: Context): Promise<void> {
  const items = ctx.theme.themes().map((definition) => ({
    id: definition.id,
    title: definition.name,
    detail: definition.scheme,
  }));
  const picked = await ctx.palette.pick(items, { placeholder: "Select a color theme", activeId: ctx.theme.activeId() });
  const rowId = ctx.settings.rowIdOf("theme");
  if (picked === undefined || rowId === undefined) {
    return;
  }
  await ctx.settings.set(rowId, "theme", picked.id);
}
