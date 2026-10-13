// The mascot is a set of images a theme supplies, keyed by the pose Grove asks
// for. Grove only asks for the poses listed here, so a theme can provide as few
// or as many as it likes and the rest are simply not drawn.

import type { ColorTheme, ThemeMascot } from './themes'

/** The poses Grove asks the active theme for. */
export const MASCOT_POSES = ['empty', 'no-session'] as const

/** Resolves the image for a pose in a theme, or null when it is off or the theme has none. */
export function resolveMascotUrl(
  theme: ColorTheme,
  pose: string,
  enabled: boolean
): string | null {
  if (!enabled) {
    return null
  }
  if (theme.mascot === undefined) {
    return null
  }
  const url = theme.mascot[pose]
  if (url === undefined) {
    return null
  }
  return url
}

/**
 * Keeps only the images a catalog theme may bring. The page's content security
 * policy lets images load from the app itself and from `data:` URLs, so a theme
 * ships its mascot inline rather than from a web address.
 */
export function acceptableMascot(raw: Record<string, string> | undefined): ThemeMascot | undefined {
  if (raw === undefined) {
    return undefined
  }
  const accepted: ThemeMascot = {}
  for (const pose of Object.keys(raw)) {
    if (raw[pose].startsWith('data:image/')) {
      accepted[pose] = raw[pose]
    }
  }
  return accepted
}
