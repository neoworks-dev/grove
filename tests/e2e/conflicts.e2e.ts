// Resolving a conflicted merge from the changes view, against a merge git
// really refused: both branches rewrite the same line of `src/clean.ts`, and
// the whole resolution — taking a side, staging, committing the merge — happens
// through the sidebar.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'

import { test, expect } from './fixtures/groveApp'

const CLEAN_TS = (greeting: string): string =>
  `export function farewell(name: string): string {\n  return \`${greeting}, \${name}\`\n}\n`

test('a conflicted merge is resolved and committed from the changes view', async ({ grove }) => {
  const main = simpleGit({ baseDir: grove.demo.root })
  const linked = simpleGit({ baseDir: grove.demo.worktreePath })

  // A path of its own, so the fixture's staged and unstaged changes stay out of
  // it. `commit <path>` takes the file rather than whatever is in the index.
  await writeFile(join(grove.demo.root, 'src/clean.ts'), CLEAN_TS('Goodbye'), 'utf8')
  await main.raw(['commit', '-m', 'main: goodbye', '--', 'src/clean.ts'])

  await writeFile(join(grove.demo.worktreePath, 'src/clean.ts'), CLEAN_TS('So long'), 'utf8')
  await linked.raw(['commit', '-m', 'feature: so long', '--', 'src/clean.ts'])

  await linked.raw(['merge', 'main']).catch(() => undefined)
  expect(await linked.raw(['status', '--porcelain'])).toContain('UU src/clean.ts')

  await grove.page.getByTitle('Worktrees', { exact: true }).click()
  await grove.page.getByRole('button', { name: /demo-worktree feature\/greeting/ }).click()
  await grove.page.getByTitle('Git Changes', { exact: true }).click()

  await expect(grove.page.getByText(/Conflicts \(1\)/)).toBeVisible()
  await expect(grove.page.getByText('src/clean.ts')).toBeVisible()

  await grove.page.getByRole('button', { name: 'theirs', exact: true }).click()

  // Taking a side clears the markers and stages the file, which is what leaves
  // the merge with nothing unresolved.
  await expect(grove.page.getByText('all conflicts resolved')).toBeVisible()
  expect(await linked.raw(['show', ':src/clean.ts'])).toContain('Goodbye')

  await grove.page.getByRole('button', { name: 'Continue merge' }).click()

  await expect
    .poll(async () => (await linked.raw(['log', '-1', '--pretty=%s'])).trim())
    .toContain("Merge branch 'main'")
  // The merge is over, so the footer goes back to the ship-it chain.
  await expect(grove.page.getByPlaceholder('Commit message')).toBeVisible()
})
