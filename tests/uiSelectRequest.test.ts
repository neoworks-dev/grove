import { expect, test } from 'bun:test'
import { parseSelectRequest, selectItems } from '../src/renderer/src/lib/nvim/uiSelectRequest'

/** A `grove_ui_select` notification as nvim sends it. */
function notification(items: unknown[], prompt: unknown = 'Code actions:'): unknown {
  return { id: 'nvim-1', method: 'grove_ui_select', args: [{ id: 7, prompt, items }] }
}

const everything = (): boolean => true

test('other notifications are not select requests', () => {
  expect(parseSelectRequest({ id: 'nvim-1', method: 'grove_popup_menu', args: [{}] })).toBeNull()
})

test('the prompt loses its trailing colon, and an empty one gets a placeholder', () => {
  expect(parseSelectRequest(notification([]))?.prompt).toBe('Code actions')
  expect(parseSelectRequest(notification([], ''))?.prompt).toBe('Select…')
})

test('usable choices come first, disabled ones after with their reason', () => {
  const request = parseSelectRequest(
    notification([
      { label: 'Extract function', disabled: 'Cannot extract empty range.' },
      { label: 'Move to a new file' },
      { label: 'Infer function return type', disabled: 'No return type.' }
    ])
  )
  if (request === null) {
    throw new Error('request did not parse')
  }
  expect(selectItems(request, everything)).toEqual([
    { id: '2', label: 'Move to a new file' },
    { id: '1', label: 'Extract function', description: 'Cannot extract empty range.' },
    { id: '3', label: 'Infer function return type', description: 'No return type.' }
  ])
})

test('ids stay nvim indices when the query filters', () => {
  const request = parseSelectRequest(notification([{ label: 'one' }, { label: 'two' }]))
  if (request === null) {
    throw new Error('request did not parse')
  }
  expect(selectItems(request, (text) => text === 'two')).toEqual([{ id: '2', label: 'two' }])
})
