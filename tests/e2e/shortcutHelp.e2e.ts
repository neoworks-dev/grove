// `?` in an empty prompt shows the agent pane's shortcuts in place of the
// conversation; anywhere else in a prompt it is just a question mark.

import { test, expect } from './fixtures/groveApp'

test('? in an empty prompt toggles the shortcut help', async ({ grove }) => {
  const page = grove.page
  const help = page.getByTestId('shortcut-help')
  await page.getByRole('button', { name: 'New session' }).click()
  const prompt = page.getByPlaceholder(/^Prompt…/)
  await prompt.click()

  await page.keyboard.press('?')
  await expect(help).toBeVisible()
  await expect(prompt).toHaveValue('')
  await expect(help.getByTestId('shortcut-row').first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  await expect(prompt).toBeFocused()
})

test('? after other text is typed as a question mark', async ({ grove }) => {
  const page = grove.page
  await page.getByRole('button', { name: 'New session' }).click()
  const prompt = page.getByPlaceholder(/^Prompt…/)
  await prompt.click()

  await page.keyboard.type('why?')
  await expect(prompt).toHaveValue('why?')
  await expect(page.getByTestId('shortcut-help')).toBeHidden()
})
