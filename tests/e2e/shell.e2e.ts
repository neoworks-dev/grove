// The window itself: the rail, the top bar, the panes it opens with.
//
// These are the cheapest tests in the suite and the ones that fail first when
// something is wrong with start-up — a pane that throws while mounting takes
// its rail entry down with it, and nothing below would ever get as far as
// asserting on content.

import { test, expect } from './fixtures/groveApp'

const RAIL = ['Explorer', 'Worktrees', 'Git Changes', 'Agents', 'Checkpoints', 'Extensions']

test('the rail offers every core view', async ({ grove }) => {
  for (const view of RAIL) {
    // By title: the rail's buttons carry one, and the editor pane has its own
    // "Explorer" button that a by-name lookup would match as well.
    await expect(grove.page.getByTitle(view, { exact: true })).toBeVisible()
  }
})

test('the top bar names the open project', async ({ grove }) => {
  // The fixture repo's directory is `demo`, and the top bar shows the repo
  // grove actually opened rather than the one it was told to remember.
  await expect(grove.page.getByRole('banner').getByRole('button', { name: 'demo' })).toBeVisible()
})

test('each rail entry opens its own view', async ({ grove }) => {
  await grove.page.getByTitle('Worktrees', { exact: true }).click()
  await expect(grove.page.getByRole('button', { name: /demo main/ })).toBeVisible()

  await grove.page.getByTitle('Git Changes', { exact: true }).click()
  await expect(grove.page.getByRole('button', { name: 'M src/util.ts' })).toBeVisible()
  // Switching views replaces the previous one rather than stacking beside it.
  await expect(grove.page.getByRole('button', { name: /demo main/ })).toHaveCount(0)
})

test('the editor pane starts with nothing open', async ({ grove }) => {
  await expect(grove.page.getByText('No file open')).toBeVisible()
  await expect(grove.page.getByRole('button', { name: 'Go to File' })).toBeVisible()
})

test('the agent pane offers the harnesses it found', async ({ grove }) => {
  await expect(grove.page.getByText('No agent session in this worktree.')).toBeVisible()
  await expect(grove.page.getByRole('button', { name: 'New session' })).toBeVisible()
  await expect(grove.page.getByRole('button', { name: 'Claude', exact: true })).toBeVisible()
})
