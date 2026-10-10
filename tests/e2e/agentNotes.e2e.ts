// The to-do list above the composer, toggled from the keyboard.
//
// Ctrl+T is pressed with the composer focused, since that is where the user's
// hands are, and the list's header reports whether it is expanded.

import { test, expect, type Page } from './fixtures/groveApp'

/** The to-do list's header button, which carries its expanded state. */
function notesHeader(page: Page) {
  return page.getByTestId('agent-notes').locator('button[aria-expanded]')
}

test('Ctrl+T in the composer hides the to-do list and shows it again', async ({ grove }) => {
  await grove.page.getByRole('button', { name: 'New session' }).click()
  await expect(notesHeader(grove.page)).toHaveAttribute('aria-expanded', 'true')

  await grove.page.getByPlaceholder(/^Prompt…/).click()
  await grove.page.keyboard.press('Control+t')
  await expect(notesHeader(grove.page)).toHaveAttribute('aria-expanded', 'false')

  await grove.page.keyboard.press('Control+t')
  await expect(notesHeader(grove.page)).toHaveAttribute('aria-expanded', 'true')
})
