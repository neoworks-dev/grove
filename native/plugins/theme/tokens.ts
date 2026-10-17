// Grove's design tokens as typed data. The values are the dark palette from the web app
// (`src/renderer/src/assets/main.css`, `lib/themes.ts`), the same ones the Neoworks design
// system ships; the names follow the Tailwind utilities Grove used (`bg-surface`, `text-dim`).
// There are no CSS variables here: components import what they need and spread it into `style`.

import type { Style } from "@neoworks/svelte-gpui/ui";

/** The palette. A theme swap replaces this object's values, nothing else. */
export const colors = {
  canvas: "#141416",
  elevated: "#262628",
  surface: "#1c1c1e",
  raised: "#1c1c1f",
  hover: "#1f1f23",
  input: "#0e0e10",

  line: "#29292b",
  lineStrong: "#3f3f46",
  lineFaint: "#ffffff0f",

  text: "#fafafa",
  muted: "#a1a1aa",
  dim: "#71717a",
  faint: "#52525b",

  accent: "#a78bfa",
  green: "#4ade80",
  red: "#f87171",
  amber: "#fbbf24",
  blue: "#60a5fa",
  redSoft: "#f8717124",
  blueGlow: "#60a5fa47",
} as const;

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

/** The window itself: canvas colour, with 8 pixels around the shell and 6 between its parts. */
export const shell: Style = {
  flex: 1,
  background: colors.canvas,
  color: colors.text,
  padding: 8,
  gap: 6,
};

/** A pane: a rounded panel on the canvas with a faint border. Clips its own content. */
export const pane: Style = {
  background: colors.surface,
  radius: radius.pane,
  borderWidth: 1,
  borderColor: colors.lineFaint,
  overflow: "hidden",
};

/** A square icon button as on the rails and in the window controls. */
export const iconButton: Style = {
  align: "center",
  justify: "center",
  radius: radius.md,
  color: colors.dim,
  transition: 120,
};

/** The hover look of an icon button. */
export const iconButtonHover: Style = { background: colors.hover, color: colors.text };

/** A floating card (menus, pickers): `bg-elevated` with a line border and the overlay shadow. */
export const overlayPanel: Style = {
  background: colors.elevated,
  borderWidth: 1,
  borderColor: colors.line,
  radius: radius.lg,
  paddingY: 4,
  color: colors.text,
  shadow: { y: 16, blur: 48, color: "#00000099" },
};
