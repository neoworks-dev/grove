// The landscape a theme may draw behind empty states, after the Neoworks landing
// page. Its colours are data on the theme so any theme can bring its own scene.

import type { ColorTheme } from './themes'

export interface LandscapeScene {
  /** A night scene draws stars and a crescent moon instead of the sun. */
  night: boolean
  sky: string
  sun: string
  star: string
  ridgeFar: string
  ridgeMidFar: string
  ridgeMid: string
  ridgeNear: string
  ridgeFront: string
  /** The outline colour shared with the marmot illustrations. */
  ink: string
}

/** The landscape to draw for a theme, or undefined when it has none or the mascot setting is off. */
export function activeLandscape(theme: ColorTheme, enabled: boolean): LandscapeScene | undefined {
  if (!enabled) {
    return undefined
  }
  return theme.decor?.landscape
}

/** The landing page by day. */
export const dayScene: LandscapeScene = {
  night: false,
  sky: '#f4ead6',
  sun: '#f7d488',
  star: 'transparent',
  ridgeFar: '#bcd2c6',
  ridgeMidFar: '#92b6a4',
  ridgeMid: '#64937b',
  ridgeNear: '#3c7258',
  ridgeFront: '#1f5f3f',
  ink: '#4a1f1a'
}

/** The landing page after dark. */
export const nightScene: LandscapeScene = {
  night: true,
  sky: '#1d1e21',
  sun: '#f7d488',
  star: 'rgba(250, 244, 220, 0.85)',
  ridgeFar: '#3a3e41',
  ridgeMidFar: '#33393a',
  ridgeMid: '#2c3332',
  ridgeNear: '#252c2a',
  ridgeFront: '#1d2522',
  ink: '#0b1317'
}

// Size in pixels, then x and y as percentages of the sky.
const STARS: [number, number, number][] = [
  [1.5, 8, 22],
  [1, 15, 48],
  [2, 22, 12],
  [1, 29, 35],
  [1.5, 36, 8],
  [1, 41, 58],
  [1.5, 47, 26],
  [1, 53, 14],
  [2, 58, 44],
  [1, 72, 18],
  [1.5, 79, 52],
  [1, 84, 9],
  [2, 90, 33],
  [1, 95, 61],
  [1, 4, 64],
  [1.5, 66, 6]
]

/** The CSS background-image that scatters the stars in a colour. */
export function starBackground(color: string): string {
  const dots = STARS.map(
    ([size, x, y]) =>
      `radial-gradient(${size}px ${size}px at ${x}% ${y}%, ${color} 50%, transparent 51%)`
  )
  return dots.join(', ')
}
