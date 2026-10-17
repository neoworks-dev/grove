// The colours the native terminal paints with, derived from the active theme. `TerminalSurface.svelte`
// passes the result as the terminal element's `theme` prop (documented in `src/terminal/theme.rs`), and
// since it reads the active tokens, a theme switch sends a new one and the terminal recolours live.
// The window colours come from the theme's tokens. The sixteen ANSI colours come from a table per
// scheme, as the editor's syntax colours do, because a theme's palette has too few colours to give
// a program all eight hues, and white and black must stay readable on the theme's own background.

import { activeScheme, activeTokens } from "./active";
import type { ThemeTokens } from "./palette";

/** What the terminal element's `theme` prop carries. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** Black, red, green, yellow, blue, magenta, cyan and white, then the bright version of each. */
  ansi: string[];
}

/** ANSI colours on a dark surface. */
export const DARK_ANSI: string[] = [
  "#27272a",
  "#f87171",
  "#4ade80",
  "#fbbf24",
  "#60a5fa",
  "#c084fc",
  "#22d3ee",
  "#d4d4d8",
  "#71717a",
  "#fca5a5",
  "#86efac",
  "#fcd34d",
  "#93c5fd",
  "#d8b4fe",
  "#67e8f9",
  "#fafafa",
];

/** ANSI colours on a light surface. */
export const LIGHT_ANSI: string[] = [
  "#27272a",
  "#dc2626",
  "#15803d",
  "#b45309",
  "#2563eb",
  "#9333ea",
  "#0e7490",
  "#a1a1aa",
  "#52525b",
  "#ef4444",
  "#16a34a",
  "#d97706",
  "#3b82f6",
  "#a855f7",
  "#0891b2",
  "#71717a",
];

/** The terminal's colours for a theme's tokens and scheme. */
export function terminalThemeFor(tokens: ThemeTokens, scheme: "dark" | "light"): TerminalTheme {
  let ansi = LIGHT_ANSI;
  if (scheme === "dark") {
    ansi = DARK_ANSI;
  }
  return {
    background: tokens.surface,
    foreground: tokens.text,
    cursor: tokens.accent,
    selection: `${tokens.accent}59`,
    ansi,
  };
}

/** The terminal's colours for the theme in use. Reactive, so reading it in markup follows a theme switch. */
export function activeTerminalTheme(): TerminalTheme {
  return terminalThemeFor(activeTokens(), activeScheme());
}
