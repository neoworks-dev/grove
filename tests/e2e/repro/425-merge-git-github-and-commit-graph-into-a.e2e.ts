// Repro for #425: Merge Git, Github and commit graph into a single plugin
//
// Recorded by `bun run qa` on 6e082241. Each `verify` is a `qa expect`
// from that session, written as the app should behave: it fails while the bug
// is there. `bun run qa replay 425` runs this file.

import { test } from '../fixtures/groveApp'
import { verify } from '../fixtures/repro'
import * as qa from '../../../scripts/qa/steps'

test("#425 Merge Git, Github and commit graph into a single plugin", async ({ grove }) => {
  const page = grove.page
  await qa.begin(grove.electron, page, { width: 1439, height: 899 })

  await page.getByRole('button', { name: 'Git' }).click()
  await page.getByRole('textbox', { name: 'Commit message' }).click()
  await page.keyboard.type("repro: graph follows the working tree", { delay: 20 })
  await page.getByRole('row', { name: 'feat: add entry point' }).click()
  await page.getByRole('row', { name: 'Uncommitted changes' }).click()
  await page.getByRole('button', { name: 'Commit to main' }).click()
  await page.getByRole('row', { name: 'repro: graph follows the working tree' }).first().waitFor({ state: 'visible', timeout: 20000 })
  await verify(page, "visible role=row:repro: graph follows the working tree", qa.visible(page.getByRole('row', { name: 'repro: graph follows the' })))
  await verify(page, "no-errors", qa.noErrors(page))
})
