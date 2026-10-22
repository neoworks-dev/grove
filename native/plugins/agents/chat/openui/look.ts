// Colours of a neoui doc, from Grove's theme. The doc was written for the suite's own palette
// (neoworks-harness apps/gui), which has a few more names than the chat's: a raised fill, the
// colour under the pointer, corner radii and three colours for the charts. They are mapped onto
// Grove's tokens here, so the nodes keep reading `p.raised`, `p.radius.s` and the rest.
import type { Tone } from "@suite/protocol/types";
import { activeTokens } from "../../../theme/active";
import type { ThemeTokens } from "../../../theme/palette";
import { blend, paletteFrom, type Palette } from "../../palette";

export interface NeouiPalette extends Palette {
  /** A fill a step above the surface: a tag, a track, a table header. */
  raised: string;
  /** What lies under the pointer. */
  hover: string;
  /** Corner radii in pixels: rows and small cards, then big cards. */
  radius: { s: number; m: number };
  /** The colours the charts take after the accent, success and danger. */
  syntax: { constant: string; keyword: string; type: string };
}

/** The doc palette for a set of theme tokens. */
export function neouiPaletteFrom(tokens: ThemeTokens): NeouiPalette {
  return {
    ...paletteFrom(tokens),
    raised: tokens.raised,
    hover: tokens.hover,
    radius: { s: 6, m: 8 },
    syntax: { constant: tokens.amber, keyword: tokens.pink, type: tokens.blue },
  };
}

/** The doc palette of the active theme, through getters so a node that reads it follows a theme switch. */
export const neouiPalette: NeouiPalette = neouiPaletteReaders();

/** An object with one getter per palette field, each reading the active theme. */
function neouiPaletteReaders(): NeouiPalette {
  const readers = {} as NeouiPalette;
  const names = Object.keys(neouiPaletteFrom(activeTokens())) as (keyof NeouiPalette)[];
  for (const name of names) {
    Object.defineProperty(readers, name, { enumerable: true, get: () => neouiPaletteFrom(activeTokens())[name] });
  }
  return readers;
}

/** The colour a tone stands for; the text colour for none. */
export function toneColor(tone: Tone | undefined, p: Palette): string {
  return tone === undefined ? p.fg : p[tone];
}

/** `color` washed into the surface: the fill behind a tag, a callout or a selected option. */
export function tint(p: Palette, color: string, percent = 16): string {
  return blend(p.surface, color, percent);
}

/** A card's outline: the border colour, or the tone's colour toned down. */
export function outline(p: Palette, tone: Tone | undefined): string {
  return tone === undefined ? p.border : blend(p.border, p[tone], 65);
}

/** The frame of a field: a thin border that turns accent while it has the keyboard and danger on an error. */
export function fieldLook(
  p: NeouiPalette,
  state: { focused?: boolean; error?: boolean },
): {
  background: string;
  borderWidth: number;
  borderColor: string;
  radius: number;
} {
  let color = p.border;
  if (state.error === true) color = p.danger;
  else if (state.focused === true) color = p.accent;
  return { background: p.bg, borderWidth: 1, borderColor: color, radius: p.radius.s };
}

/** The colours of a button by its variant. */
export function buttonLook(
  p: NeouiPalette,
  variant: string | undefined,
): { background: string; hover: string; border: string; color: string } {
  if (variant === "primary") {
    return {
      background: p.accent,
      hover: blend(p.accent, p.fg, 18),
      border: p.accent,
      color: p.bg,
    };
  }
  if (variant === "danger") {
    return {
      background: tint(p, p.danger, 14),
      hover: tint(p, p.danger, 26),
      border: blend(p.border, p.danger, 70),
      color: p.danger,
    };
  }
  return { background: p.surface, hover: p.raised, border: p.border, color: p.fg };
}
