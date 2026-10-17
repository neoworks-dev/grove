// `splitChildFlex` (layoutTree.ts) speaks CSS: one `"grow shrink basis"` string per child. The
// native style object takes the three as separate keys, so this reads the string back.

import type { Size } from "@neoworks/svelte-gpui/ui";

export interface ChildFlex {
  grow: number;
  shrink: number;
  basis: Size;
}

/** Reads a `"1 1 0%"` or `"0 0 240px"` shorthand into the style's `grow`, `shrink` and `basis`. */
export function parseFlex(shorthand: string): ChildFlex {
  const [grow, shrink, basis] = shorthand.split(" ");
  return { grow: Number(grow), shrink: Number(shrink), basis: parseBasis(basis) };
}

/** A pixel basis becomes a number and a percentage stays a string. */
function parseBasis(basis: string): Size {
  if (basis.endsWith("px")) {
    return Number(basis.slice(0, -2));
  }
  return basis as Size;
}
