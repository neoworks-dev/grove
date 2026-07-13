// Color-theme registry with pluggable themes. A theme is a full set of CSS
// custom-property values applied inline on <html>, so it fully overrides the
// design-system tokens (bg, surfaces, text, borders, accents). Applying inline
// (rather than editing CSS) means a plugin can register a theme at runtime with
// a plain object — no stylesheet changes needed. Each theme also carries a
// matching Monaco editor theme so the code editor chrome tracks the app.

// The complete palette every theme must define. Keeping the key set identical
// across themes means switching never leaves a stale value behind.
export interface ThemePalette {
  bg: string
  bgElevated: string
  surface: string
  surfaceRaised: string
  surfaceHover: string
  surfaceInput: string
  border: string
  borderStrong: string
  borderFaint: string
  text: string
  textMuted: string
  textDim: string
  textFaint: string
  textInverse: string
  primary: string
  primaryHover: string
  primaryFg: string
  secondaryHover: string
  secondaryFg: string
  focusRing: string
  gridDot: string
  gridDotBold: string
  overlayScrim: string
  ctxGreen: string
  ctxRed: string
  ctxAmber: string
  ctxBlue: string
  ctxViolet: string
  ctxPink: string
}

export interface ColorTheme {
  name: string
  label: string
  scheme: 'dark' | 'light'
  palette: ThemePalette
}

// Maps a palette field to its CSS custom-property name.
const CSS_VARS: Record<keyof ThemePalette, string> = {
  bg: '--bg',
  bgElevated: '--bg-elevated',
  surface: '--surface',
  surfaceRaised: '--surface-raised',
  surfaceHover: '--surface-hover',
  surfaceInput: '--surface-input',
  border: '--border',
  borderStrong: '--border-strong',
  borderFaint: '--border-faint',
  text: '--text',
  textMuted: '--text-muted',
  textDim: '--text-dim',
  textFaint: '--text-faint',
  textInverse: '--text-inverse',
  primary: '--primary',
  primaryHover: '--primary-hover',
  primaryFg: '--primary-fg',
  secondaryHover: '--secondary-hover',
  secondaryFg: '--secondary-fg',
  focusRing: '--focus-ring',
  gridDot: '--grid-dot',
  gridDotBold: '--grid-dot-bold',
  overlayScrim: '--overlay-scrim',
  ctxGreen: '--ctx-green',
  ctxRed: '--ctx-red',
  ctxAmber: '--ctx-amber',
  ctxBlue: '--ctx-blue',
  ctxViolet: '--ctx-violet',
  ctxPink: '--ctx-pink'
}

// ── Neoworks base (dark) — the design-system default palette. ──────────
const neoworksDark: ThemePalette = {
  bg: '#000000',
  bgElevated: '#0b0b0d',
  surface: '#141416',
  surfaceRaised: '#1c1c1f',
  surfaceHover: '#1f1f23',
  surfaceInput: '#0e0e10',
  border: '#262626',
  borderStrong: '#3f3f46',
  borderFaint: 'rgba(255, 255, 255, 0.06)',
  text: '#fafafa',
  textMuted: '#a1a1aa',
  textDim: '#71717a',
  textFaint: '#52525b',
  textInverse: '#0b0b0d',
  primary: '#fafafa',
  primaryHover: '#e4e4e7',
  primaryFg: '#0b0b0d',
  secondaryHover: '#1f1f23',
  secondaryFg: '#fafafa',
  focusRing: 'rgba(250, 250, 250, 0.55)',
  gridDot: 'rgba(255, 255, 255, 0.045)',
  gridDotBold: 'rgba(255, 255, 255, 0.16)',
  overlayScrim: 'rgba(0, 0, 0, 0.66)',
  ctxGreen: '#4ade80',
  ctxRed: '#f87171',
  ctxAmber: '#fbbf24',
  ctxBlue: '#60a5fa',
  ctxViolet: '#a78bfa',
  ctxPink: '#f472b6'
}

// ── Neoworks light — the design-system light palette. ──────────────────
const neoworksLight: ThemePalette = {
  bg: '#f4f4f5',
  bgElevated: '#ffffff',
  surface: '#ffffff',
  surfaceRaised: '#f9f9fa',
  surfaceHover: '#e4e4e7',
  surfaceInput: '#ffffff',
  border: '#d4d4d8',
  borderStrong: '#a1a1aa',
  borderFaint: 'rgba(0, 0, 0, 0.08)',
  text: '#09090b',
  textMuted: '#3f3f46',
  textDim: '#52525b',
  textFaint: '#71717a',
  textInverse: '#fafafa',
  primary: '#09090b',
  primaryHover: '#3f3f46',
  primaryFg: '#ffffff',
  secondaryHover: '#e4e4e7',
  secondaryFg: '#09090b',
  focusRing: 'rgba(9, 9, 11, 0.5)',
  gridDot: 'rgba(0, 0, 0, 0.18)',
  gridDotBold: 'rgba(0, 0, 0, 0.3)',
  overlayScrim: 'rgba(9, 9, 11, 0.45)',
  ctxGreen: '#16a34a',
  ctxRed: '#dc2626',
  ctxAmber: '#d97706',
  ctxBlue: '#2563eb',
  ctxViolet: '#7c3aed',
  ctxPink: '#db2777'
}

// Only the two Neoworks design-system palettes ship by default. Every other
// theme (Midnight, Ember, Nord, Gruvbox, Catppuccin Mocha, …) lives in the
// extensions catalog and is registered at runtime once installed.
const builtins: ColorTheme[] = [
  { name: 'neoworks', label: 'Neoworks (Dark)', scheme: 'dark', palette: neoworksDark },
  { name: 'neoworks-light', label: 'Neoworks Light', scheme: 'light', palette: neoworksLight }
]

const themes = new Map<string, ColorTheme>()
for (const theme of builtins) themes.set(theme.name, theme)

const DEFAULT_THEME = 'neoworks'
let activeName = DEFAULT_THEME

export function availableThemes(): ColorTheme[] {
  return [...themes.values()]
}

// Register a theme at runtime (plugin hook). Returns an unregister function.
export function registerTheme(theme: ColorTheme): () => void {
  themes.set(theme.name, theme)
  return () => themes.delete(theme.name)
}

export function currentThemeName(): string {
  return activeName
}

// Resolve a theme (falls back to the default) — used to build per-instance
// themes for theme-dependent views.
export function themeFor(name: string): ColorTheme {
  return themes.get(name) || themes.get(DEFAULT_THEME)!
}

export function paletteFor(name: string): ThemePalette {
  return themeFor(name).palette
}

// The design-system base palette for a scheme — catalog themes provide partial
// overrides merged over this so they don't have to specify all 30 fields.
export function basePalette(scheme: 'dark' | 'light'): ThemePalette {
  return scheme === 'light' ? neoworksLight : neoworksDark
}

// Write a theme's palette as inline CSS variables on <html> and set data-theme
// (drives color-scheme and the [data-theme='light'] soft-accent overrides).
export function applyThemeVars(name: string): void {
  const theme = themes.get(name)
  if (!theme) return
  const root = document.documentElement
  root.setAttribute('data-theme', theme.scheme)
  for (const key of Object.keys(CSS_VARS) as (keyof ThemePalette)[]) {
    root.style.setProperty(CSS_VARS[key], theme.palette[key])
  }
  activeName = name
  localStorage.setItem('colorTheme', name)
}

// Apply the saved (or default) theme on boot.
export function initThemes(): void {
  const saved = localStorage.getItem('colorTheme')
  applyThemeVars(saved && themes.has(saved) ? saved : DEFAULT_THEME)
}
