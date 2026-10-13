// The Neoworks marmot, bundled with the app and attached to the built-in themes.
// Kept apart from the theme registry because the glob below only exists under Vite.

import { attachMascot, availableThemes } from './themes'
import type { ThemeMascot } from './themes'

const poseUrls = import.meta.glob<string>('../assets/marmot/**/*.webp', {
  eager: true,
  query: '?url',
  import: 'default'
})

/** Resolves a bundled marmot image by its path under the assets folder, such as "apps/coder". */
function marmotUrl(path: string): string {
  return poseUrls[`../assets/marmot/${path}.webp`]
}

/** Gives every built-in theme the marmot, each Grove pose mapped to one of its images. */
export function attachMarmot(): void {
  const marmot: ThemeMascot = {
    empty: marmotUrl('sleeping'),
    'no-session': marmotUrl('apps/coder')
  }
  for (const theme of availableThemes()) {
    attachMascot(theme.name, marmot)
  }
}
