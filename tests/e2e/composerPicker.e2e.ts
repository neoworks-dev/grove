// `/model`, `/effort` and `/fast` open a list directly above the prompt.
//
// Arrows move between rows, Enter picks, Escape closes and the keyboard goes
// back to the prompt. Model and effort sit under the prompt as plain text.

import { test, expect, type Page } from './fixtures/groveApp'

/** The prompt's textarea. */
function prompt(page: Page) {
  return page.getByPlaceholder(/^Prompt…/)
}

/** Types a bare slash command and sends it, past the completion that offers its name first. */
async function runCommand(page: Page, name: string): Promise<void> {
  await prompt(page).click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
}

test('/effort opens a list above the prompt, arrows and Enter pick, and the status line shows it as text', async ({
  grove
}) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await runCommand(page, '/effort')

  const picker = page.getByTestId('composer-picker')
  await expect(picker).toBeVisible()
  const pickerBox = await picker.boundingBox()
  const promptBox = await prompt(page).boundingBox()
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(promptBox!.y)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(prompt(page)).toBeFocused()
  await expect(page.getByTestId('agent-model-state')).toContainText('medium')
  await expect(page.locator('select')).toHaveCount(0)
})

test('Escape closes the picker and returns to the prompt', async ({ grove }) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await runCommand(page, '/model')
  await expect(page.getByTestId('composer-picker')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-picker')).toBeHidden()
  await expect(prompt(page)).toBeFocused()
})

test('/fast offers fast mode with its warning', async ({ grove }) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  await runCommand(page, '/fast')
  await expect(page.getByTestId('composer-picker')).toContainText('uses up your usage limits faster')
})
