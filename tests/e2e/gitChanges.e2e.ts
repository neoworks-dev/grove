// The git changes view, against the fixture repo's working tree.
//
// The demo repo is built with exactly one staged change (src/util.ts) and one
// unstaged change (src/index.ts), because a view that renders the two the same
// way is only half tested. Staging is driven through the button rather than
// through git, so the assertion covers the round trip: click, main process,
// git, refreshed view.

import { test, expect } from './fixtures/groveApp'

/** Open the view and wait for it to have read the working tree. */
async function openGitChanges(page: import('./fixtures/groveApp').Page): Promise<void> {
  await page.getByTitle('Git Changes', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'M src/util.ts' })).toBeVisible()
}

test('both changed files are listed', async ({ grove }) => {
  await openGitChanges(grove.page)

  await expect(grove.page.getByRole('button', { name: 'M src/util.ts' })).toBeVisible()
  await expect(grove.page.getByRole('button', { name: 'M src/index.ts' })).toBeVisible()
})

test('a staged file and an unstaged one are offered different actions', async ({ grove }) => {
  await openGitChanges(grove.page)

  // util.ts was added to the index by the fixture; index.ts was not.
  await expect(grove.page.getByRole('button', { name: /staged/ })).toBeVisible()
  await expect(grove.page.getByRole('button', { name: /stage \+/ })).toBeVisible()
})

test('staging a file through the UI moves it to the index', async ({ grove }) => {
  await openGitChanges(grove.page)

  await grove.page.getByRole('button', { name: /stage \+/ }).click()

  // Nothing is left to stage once the second file has gone in, which is the
  // view's own way of saying git agreed.
  await expect(grove.page.getByRole('button', { name: /stage \+/ })).toHaveCount(0)
  await expect(grove.page.getByRole('button', { name: /staged/ })).toHaveCount(2)
})

test('the commit box and its actions are present', async ({ grove }) => {
  await openGitChanges(grove.page)

  await expect(grove.page.getByRole('textbox', { name: 'Commit message' })).toBeVisible()
  await expect(grove.page.getByRole('button', { name: 'Commit' })).toBeVisible()
})
