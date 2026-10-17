// The colours of a theme, as typed data. Grove's two built-in themes are the Neoworks design
// system's dark and light palettes from the web app's `lib/themes.ts`; each field here is the
// palette entry of that file under the name the shell's components already use (`bg` is
// `canvas`, `border` is `line`, `ctxViolet` is `accent`). Colours are `#rrggbb` or `#rrggbbaa`,
// the forms the host understands.

/** Every colour a theme defines. Keeping the key set the same across themes means switching never leaves a stale value. */
export interface ThemeTokens {
  /** The window behind everything. */
  canvas: string;
  /** Floating cards: menus, pickers, the palette. */
  elevated: string;
  /** Panes. */
  surface: string;
  raised: string;
  hover: string;
  /** Text fields. */
  input: string;

  line: string;
  lineStrong: string;
  lineFaint: string;

  text: string;
  muted: string;
  dim: string;
  faint: string;
  /** Text on a filled accent or primary background. */
  inverse: string;

  accent: string;
  primary: string;
  primaryFg: string;
  focusRing: string;

  green: string;
  red: string;
  amber: string;
  blue: string;
  pink: string;
  redSoft: string;
  blueGlow: string;

  /** The dimming behind a modal card. */
  scrim: string;
}

export interface ThemeDefinition {
  /** Names the theme in the profile and in `registerTheme`. */
  id: string;
  /** What menus and pickers call it. */
  name: string;
  scheme: "dark" | "light";
  tokens: ThemeTokens;
}

/** The Neoworks dark palette, which is also what the shell draws before any theme is active. */
export const NEOWORKS_DARK: ThemeTokens = {
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
  inverse: "#0b0b0d",

  accent: "#a78bfa",
  primary: "#fafafa",
  primaryFg: "#0b0b0d",
  focusRing: "#fafafa8c",

  green: "#4ade80",
  red: "#f87171",
  amber: "#fbbf24",
  blue: "#60a5fa",
  pink: "#f472b6",
  redSoft: "#f8717124",
  blueGlow: "#60a5fa47",

  scrim: "#000000a8",
};

/** The Neoworks light palette. */
export const NEOWORKS_LIGHT: ThemeTokens = {
  canvas: "#f4f4f5",
  elevated: "#ffffff",
  surface: "#ffffff",
  raised: "#f9f9fa",
  hover: "#e4e4e7",
  input: "#ffffff",

  line: "#d4d4d8",
  lineStrong: "#a1a1aa",
  lineFaint: "#00000014",

  text: "#09090b",
  muted: "#3f3f46",
  dim: "#52525b",
  faint: "#71717a",
  inverse: "#fafafa",

  accent: "#7c3aed",
  primary: "#09090b",
  primaryFg: "#ffffff",
  focusRing: "#09090b80",

  green: "#16a34a",
  red: "#dc2626",
  amber: "#d97706",
  blue: "#2563eb",
  pink: "#db2777",
  redSoft: "#dc262624",
  blueGlow: "#2563eb47",

  scrim: "#09090b73",
};

export const CORE_THEMES: ThemeDefinition[] = [
  { id: "neoworks", name: "Neoworks (Dark)", scheme: "dark", tokens: NEOWORKS_DARK },
  { id: "neoworks-light", name: "Neoworks Light", scheme: "light", tokens: NEOWORKS_LIGHT },
];

/** The theme the profile selects when it does not say. */
export const DEFAULT_THEME_ID = "neoworks";
