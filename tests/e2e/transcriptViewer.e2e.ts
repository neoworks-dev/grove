// The detailed transcript, toggled and left from the keyboard.
//
// Ctrl+O is pressed with the composer focused, since that is where the user's
// hands are; inside the viewer, q and Escape leave it and / opens a search.

import { test, expect } from './fixtures/groveApp'

test('Ctrl+O shows the detailed transcript and q, Escape and Ctrl+O leave it', async ({
  grove
}) => {
  const page = grove.page
  const viewer = page.getByTestId('transcript-viewer')
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByPlaceholder(/^Prompt…/).click()

  await page.keyboard.press('Control+o')
  await expect(viewer).toBeVisible()

  await page.keyboard.press('q')
  await expect(viewer).toBeHidden()

  await page.keyboard.press('Control+o')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  await page.keyboard.press('Control+o')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Control+o')
  await expect(viewer).toBeHidden()
})

test('/ in the viewer opens a search box, and Escape closes just the search', async ({ grove }) => {
  const page = grove.page
  const viewer = page.getByTestId('transcript-viewer')
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByPlaceholder(/^Prompt…/).click()
  await page.keyboard.press('Control+o')

  await page.keyboard.press('/')
  const search = page.getByLabel('Search the transcript')
  await expect(search).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
  await expect(viewer).toBeVisible()
})
