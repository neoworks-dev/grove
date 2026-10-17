// The tokens the shell draws with right now. This is a reactive module and not a field of the
// theme service so that components can read it without a service in reach: `colors` in
// `tokens.ts` reads through it, and a component that reads a colour in its markup draws again
// when the theme service swaps the tokens. Before a theme is active, and after the theme
// plugin unloads, it holds the dark palette.

import { createChangeSignal } from "../../kernel/reactive";
import { NEOWORKS_DARK, type ThemeTokens } from "./palette";

let current: ThemeTokens = NEOWORKS_DARK;
let currentScheme: "dark" | "light" = "dark";
const changes = createChangeSignal();

/** The tokens in use. Reading it inside an effect or a template makes that rerun on a theme change. */
export function activeTokens(): ThemeTokens {
  changes.track();
  return current;
}

/** Whether the theme in use is a dark or a light one. Reactive like `activeTokens`. */
export function activeScheme(): "dark" | "light" {
  changes.track();
  return currentScheme;
}

/** Makes these the tokens in use and redraws everything that read a colour. */
export function setActiveTokens(tokens: ThemeTokens, scheme: "dark" | "light"): void {
  current = tokens;
  currentScheme = scheme;
  changes.notify();
}
