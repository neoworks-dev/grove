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
