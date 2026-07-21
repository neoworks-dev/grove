// Per-pane font zoom math. Kept in a plain module (no Svelte runes) so the
// clamping/stepping is unit-testable and shared by the layout store.

export const FONT_SCALE_MIN = 0.5
export const FONT_SCALE_MAX = 3
export const FONT_SCALE_STEP = 0.1
export const FONT_SCALE_DEFAULT = 1

// Clamp a raw multiplier into the allowed zoom range, rounding to the step grid
// so repeated +/- stepping never drifts on floating-point error (0.1 + 0.2 …).
export function clampFontScale(value: number): number {
  const snapped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP
  const bounded = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, snapped))
  // Trim the binary-float tail the multiply/divide reintroduces (e.g. 1.3000004).
  return Math.round(bounded * 100) / 100
}

// The multiplier after stepping the current one by `deltaSteps` (±1 per keypress).
export function steppedFontScale(current: number, deltaSteps: number): number {
  return clampFontScale(current + deltaSteps * FONT_SCALE_STEP)
}
