// The items under the prompt, reached from the keyboard.
//
// Down from the prompt lands on the first one, left and right walk along them,
// Enter opens one, and Escape or up goes back to the prompt.

import { test, expect, type Page } from './fixtures/groveApp'

/** The prompt's textarea. */
function prompt(page: Page) {
  return page.getByPlaceholder(/^Prompt…/)
}

test('down from the prompt selects the first item, arrows walk along them, up goes back', async ({
  grove
}) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await prompt(page).click()

  await page.keyboard.press('ArrowDown')
  // The first item is the harness button; its name is the harness, so it is found by its marker.
  const harness = page.locator('[data-footer-item]').first()
  await expect(harness).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('agent-mode-trigger')).toBeFocused()

  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('agent-mode-trigger')).not.toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(prompt(page)).toBeFocused()
})

test('Enter opens the selected item, Escape closes it and returns to the prompt, and a click on the prompt returns too', async ({
  grove
}) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await prompt(page).click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('agent-mode-trigger')).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('agent-mode-trigger')).toHaveAttribute('aria-expanded', 'false')
  await expect(prompt(page)).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-footer-item]').first()).toBeFocused()
  await prompt(page).click()
  await expect(prompt(page)).toBeFocused()
})

test('Shift+Tab still cycles the mode while an item is selected', async ({ grove }) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await prompt(page).click()
  await page.keyboard.press('ArrowDown')
  const trigger = page.getByTestId('agent-mode-trigger')
  const before = await trigger.innerText()

  await page.keyboard.press('Shift+Tab')
  await expect(trigger).not.toHaveText(before)
})
