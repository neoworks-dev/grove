// The worktrees view, against the fixture repo's actual worktrees.
//
// Grove is a worktree editor, so this is the view that has to be right: the
// demo repo is built with a main worktree carrying uncommitted changes and a
// linked one on `feature/greeting` that is clean, and both facts should be
// legible without opening anything.

import { test, expect } from './fixtures/groveApp'

test('both worktrees are listed with their branches', async ({ grove }) => {
  await grove.page.getByTitle('Worktrees', { exact: true }).click()

  const main = grove.page.getByRole('button', { name: /demo main/ })
  const linked = grove.page.getByRole('button', { name: /demo-worktree feature\/greeting/ })

  await expect(main).toBeVisible()
  await expect(linked).toBeVisible()
})

test('the view distinguishes the dirty worktree from the clean one', async ({ grove }) => {
  await grove.page.getByTitle('Worktrees', { exact: true }).click()

  // The fixture leaves a staged and an unstaged change on main and nothing on
  // the linked worktree, so the two rows must not read the same.
  await expect(grove.page.getByRole('button', { name: /^dirty demo main/ })).toBeVisible()
  await expect(grove.page.getByRole('button', { name: /^clean demo-worktree/ })).toBeVisible()
})

test('the status bar names the branch the worktree is on', async ({ grove }) => {
  await expect(grove.page.getByRole('contentinfo')).toContainText('main')
})
