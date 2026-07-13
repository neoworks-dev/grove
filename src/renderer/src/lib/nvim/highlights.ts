// Highlight resolution for the nvim grid: hl_attr_define entries stored by
// id, resolved against default_colors_set with reverse-video handling.

import type { GridState, HlAttrs, ResolvedColors } from './types'

export function rgbToCss(value: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, value))
  return `#${clamped.toString(16).padStart(6, '0')}`
}

export function defineHighlight(state: GridState, id: number, attrs: Record<string, unknown>): void {
  const entry: HlAttrs = {}
  if (typeof attrs.foreground === 'number') entry.foreground = attrs.foreground
  if (typeof attrs.background === 'number') entry.background = attrs.background
  if (typeof attrs.special === 'number') entry.special = attrs.special
  if (attrs.reverse === true) entry.reverse = true
  if (attrs.bold === true) entry.bold = true
  if (attrs.italic === true) entry.italic = true
  if (attrs.underline === true) entry.underline = true
  if (attrs.undercurl === true) entry.undercurl = true
  if (attrs.strikethrough === true) entry.strikethrough = true
  state.hl.set(id, entry)
}

export function resolveColors(state: GridState, hlId: number): ResolvedColors {
  const attrs = state.hl.get(hlId) ?? {}
  let fg = attrs.foreground ?? state.defaults.fg
  let bg = attrs.background ?? state.defaults.bg
  const sp = attrs.special ?? state.defaults.sp
  if (attrs.reverse) {
    const swap = fg
    fg = bg
    bg = swap
  }
  return { fg: rgbToCss(fg), bg: rgbToCss(bg), sp: rgbToCss(sp) }
}

export function highlightAttrs(state: GridState, hlId: number): HlAttrs {
  return state.hl.get(hlId) ?? {}
}
