// The colours and text sizes the chat draws with, from Grove's active theme. The chat was
// written for the suite's own theme (neoworks-harness apps/gui), where a palette has eight
// colours; this maps Grove's tokens onto those names, so the ported components keep reading
// `p.fg`, `p.surface` and the rest. The fields are getters, so a component that reads one in its
// markup follows a theme switch, the way `colors` in `theme/tokens.ts` does.

import { activeTokens } from "../theme/active";
import type { ThemeTokens } from "../theme/palette";

export interface Palette {
  fg: string;
  /** The pane the chat sits in. */
  bg: string;
  /** Cards and code, set into the pane. */
  surface: string;
  border: string;
  accent: string;
  muted: string;
  success: string;
  danger: string;
  /** The band behind the user's own messages and the input: the pane with a little text mixed in. */
  band: string;
  /** Pixels. */
  space: { s: number; m: number; l: number };
  text: { title: number; body: number; code: number };
}

/** Pixel sizes, on Grove's 4 pixel grid and type scale. */
const SPACE = { s: 4, m: 8, l: 16 } as const;
const TEXT = { title: 15, body: 13, code: 12 } as const;

/** How much of the text colour the band takes on, in percent. */
const BAND_PERCENT = 7;

/** The `#rrggbb` channels of a colour, or undefined for any other form. */
function channels(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!match) {
    return undefined;
  }
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

/** `over` mixed into `base` by `percent`; `base` unchanged when either is not `#rrggbb`. */
export function blend(base: string, over: string, percent: number): string {
  const baseChannels = channels(base);
  const overChannels = channels(over);
  if (!baseChannels || !overChannels) {
    return base;
  }
  const mix = (from: number, to: number): number => Math.round((from * (100 - percent) + to * percent) / 100);
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  const mixed = baseChannels.map((from, index) => hex(mix(from, overChannels[index])));
  return `#${mixed.join("")}`;
}

/** The chat palette for a set of theme tokens. */
export function paletteFrom(tokens: ThemeTokens): Palette {
  return {
    fg: tokens.text,
    bg: tokens.surface,
    surface: tokens.input,
    border: tokens.line,
    accent: tokens.accent,
    muted: tokens.muted,
    success: tokens.green,
    danger: tokens.red,
    band: blend(tokens.surface, tokens.text, BAND_PERCENT),
    space: SPACE,
    text: TEXT,
  };
}

/** The chat palette of the active theme, read through getters so it is always current. */
export const palette: Palette = paletteReaders();

/** An object with one getter per palette field, each reading the active theme. */
function paletteReaders(): Palette {
  const readers = {} as Palette;
  const names = Object.keys(paletteFrom(activeTokens())) as (keyof Palette)[];
  for (const name of names) {
    Object.defineProperty(readers, name, { enumerable: true, get: () => paletteFrom(activeTokens())[name] });
  }
  return readers;
}
