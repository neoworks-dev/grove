import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// A component that destructures a prop named `state` makes the compiler read
// `$state` as a store subscription rather than the rune, and the component dies
// on mount with `store_invalid_shape`. That takes the whole render tree with it
// — Grove froze at whatever was on screen the moment such a pane appeared — so
// this is worth catching at the repository level rather than in a review.
function svelteFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...svelteFiles(path))
      continue
    }
    if (path.endsWith('.svelte')) found.push(path)
  }
  return found
}

describe('$props destructuring', () => {
  test('no component binds a prop to the name `state`', () => {
    const offenders: string[] = []
    for (const path of svelteFiles('src/renderer/src')) {
      const source = readFileSync(path, 'utf8')
      if (!source.includes('$props()')) continue
      // `state` on its own, not `state: renamed` and not `paneState`.
      if (/\blet\s*\{[^}]*(^|[{,\s])state\s*[,}]/s.test(source)) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
