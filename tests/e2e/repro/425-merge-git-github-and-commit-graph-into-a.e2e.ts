// Repro for #425: Merge Git, Github and commit graph into a single plugin
//
// Recorded by `bun run qa` on 91bf13f8. Each `verify` is a `qa expect`
// from that session, written as the app should behave: it fails while the bug
// is there. `bun run qa replay 425` runs this file.

import { test } from '../fixtures/groveApp'
import { verify } from '../fixtures/repro'
import * as qa from '../../../scripts/qa/steps'

test("#425 Merge Git, Github and commit graph into a single plugin", async ({ grove }) => {
  const page = grove.page
  await qa.begin(grove.electron, page, { width: 1439, height: 899 })

  await qa.pane(page, {"paneTypeId":"git","close":false,"split":null,"inPaneType":null})
  await page.getByRole('button', { name: 'Source Control' }).click()
  await page.getByRole('textbox', { name: 'Commit message' }).click()
  await page.keyboard.type("repro: graph follows source control", { delay: 20 })
  await page.getByRole('button', { name: 'Commit to main' }).click()
  // The commit has landed once Source Control lists it; the graph gets a moment
  // to follow, which it never did while each view kept its own git state.
  await page.getByRole('treeitem', { name: 'repro: graph follows source control' }).waitFor()
  await page
    .getByRole('row', { name: 'repro: graph follows source' })
    .waitFor({ timeout: 2000 })
    .catch(() => {})
  await verify(page, "visible role=row:repro: graph follows source control", qa.visible(page.getByRole('row', { name: 'repro: graph follows source' })))
  await verify(page, "no-errors", qa.noErrors(page))
})
