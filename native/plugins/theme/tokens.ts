// Grove's design tokens as typed data. Colours come from the active theme (`palette.ts` has
// Grove's palettes, the theme service picks one) and are read through `colors`; the rest are
// fixed sizes. The names follow the Tailwind utilities Grove used (`bg-surface`, `text-dim`).
// There are no CSS variables here: components import what they need and spread it into `style`.

import type { Style } from "@neoworks/svelte-gpui/ui";
import { activeScheme, activeTokens } from "./active";
import { NEOWORKS_DARK, type ThemeTokens } from "./palette";

/**
 * The palette of the active theme. Each field is a getter, so `colors.text` read in a template
 * follows a theme switch with no change to the component, and a `Style` spread in a `$derived`
 * does too. Read at module level or in a plain `const`, a colour is fixed to the theme of the
 * moment, so keep colours inside markup, `$derived` and functions.
 */
export const colors: Readonly<ThemeTokens> = tokenReaders();

/** An object with one getter per token, each reading the active theme. */
function tokenReaders(): ThemeTokens {
  const readers = {} as ThemeTokens;
  for (const name of Object.keys(NEOWORKS_DARK) as (keyof ThemeTokens)[]) {
    Object.defineProperty(readers, name, { enumerable: true, get: () => activeTokens()[name] });
  }
  return readers;
}

/** Spacing steps on the 4 pixel grid. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16 } as const;

/** Corner radii: `rounded-md`, `rounded-lg` and `rounded-xl` in Grove. */
export const radius = { sm: 4, md: 6, lg: 8, pane: 12 } as const;

/** Type scale: `text-2xs`, `text-xs` and `text-sm`. */
export const fontSize = { xxs: 11, xs: 12, sm: 13 } as const;

/** Sizes of the shell's fixed parts. */
export const size = {
  headerHeight: 28,
  statusBarHeight: 24,
  railWidth: 36,
  railButton: 32,
  gutter: 8,
  tabStripHeight: 32,
  windowButtonWidth: 28,
  windowButtonHeight: 24,
  commandCenterWidth: 340,
  sidebarWidth: 240,
  panelHeight: 200,
} as const;

// The styles below read colours in getters, so they follow the theme when a primitive reads them
// while drawing: pass them as `style={shell}`, or spread them inside markup or a `$derived`.

/** The window itself: canvas colour, with 8 pixels around the shell and 6 between its parts. */
export const shell: Style = {
  flex: 1,
  get background() {
    return colors.canvas;
  },
  get color() {
    return colors.text;
  },
  padding: 8,
  gap: 6,
};

/** A pane: a rounded panel on the canvas with a faint border. Clips its own content. */
export const pane: Style = {
  get background() {
    return colors.surface;
  },
  radius: radius.pane,
  borderWidth: 1,
  get borderColor() {
    return colors.lineFaint;
  },
  overflow: "hidden",
};

/** A square icon button as on the rails and in the window controls. */
export const iconButton: Style = {
  align: "center",
  justify: "center",
  radius: radius.md,
  get color() {
    return colors.dim;
  },
  transition: 120,
};

/** The hover look of an icon button. */
export const iconButtonHover: Style = {
  get background() {
    return colors.hover;
  },
  get color() {
    return colors.text;
  },
};

/** A floating card (menus, pickers): `bg-elevated` with a line border and the overlay shadow. */
export const overlayPanel: Style = {
  get background() {
    return colors.elevated;
  },
  borderWidth: 1,
  get borderColor() {
    return colors.line;
  },
  radius: radius.lg,
  paddingY: 4,
  get color() {
    return colors.text;
  },
  shadow: { y: 16, blur: 48, color: "#00000099" },
};

/**
 * What to lay over the rows of a svelte-gpui `Menu`. The menu draws row text in a fixed near-white
 * that only reads on a dark panel, so on a light theme the rows take the theme's text colour. On a
 * dark theme there is nothing to override, which keeps disabled rows greyed.
 */
export function menuItemStyle(): Style | undefined {
  if (activeScheme() === "dark") {
    return undefined;
  }
  return { color: colors.text };
}
