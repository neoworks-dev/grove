/**
 * Keyboard focus among the items under the prompt: the background tasks, the
 * harness, model, mode, review and thinking buttons, the stop button. Items mark
 * themselves with `data-footer-item`, so what is listed follows what is on screen.
 */

/** The attribute that marks an element as a footer item. */
export const FOOTER_ITEM_ATTRIBUTE = 'data-footer-item'

/** Marks an item that handles its own up and escape keys, like the background task list. */
export const FOOTER_OWN_KEYS = 'own-keys'

/** Where the keyboard goes from `current` when stepping by `direction`, over items that may be disabled. */
export function nextEnabledIndex(
  disabled: boolean[],
  current: number,
  direction: 1 | -1
): number | null {
  let index = current + direction
  while (index >= 0 && index < disabled.length) {
    if (!disabled[index]) return index
    index += direction
  }
  return null
}

/** The items under the prompt, in the order they are on screen. */
export function footerItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${FOOTER_ITEM_ATTRIBUTE}]`))
}

/** Whether an item cannot take focus right now. */
function isDisabled(item: HTMLElement): boolean {
  return item instanceof HTMLButtonElement && item.disabled
}

/** The footer item the keyboard is on, or null when it is somewhere else. */
export function focusedFooterItem(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return null
  const items = footerItems(root)
  const found = items.find((item) => item === active)
  if (found === undefined) return null
  return found
}

/** Puts the keyboard on the first item that can take it; false when there is none. */
export function focusFirstFooterItem(root: HTMLElement): boolean {
  const items = footerItems(root)
  const target = nextEnabledIndex(items.map(isDisabled), -1, 1)
  if (target === null) return false
  items[target].focus()
  return true
}

/** Moves the keyboard one item along; false when it is already at that end. */
export function stepFooterItem(root: HTMLElement, direction: 1 | -1): boolean {
  const items = footerItems(root)
  const current = items.findIndex((item) => item === document.activeElement)
  if (current === -1) return false
  const target = nextEnabledIndex(items.map(isDisabled), current, direction)
  if (target === null) return false
  items[target].focus()
  return true
}

/** The trigger of a menu that is open inside the footer, if one is. */
export function openFooterMenuTrigger(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[aria-expanded="true"][data-footer-item]')
}
