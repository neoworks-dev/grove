/**
 * The pickers the composer opens in place of sending a command: `/model`, `/effort`
 * and `/fast` with nothing after them choose from a list above the prompt, where
 * the command alone would only have gone to the harness.
 */

/** Why fast mode is flagged wherever it is offered: it is quicker, and it is paid for. */
export const FAST_MODE_WARNING =
  'Fast mode answers quicker, and uses up your usage limits faster. It stays on for this session until you turn it off.'

export type PickerKind = 'model' | 'effort' | 'fast'

const PICKER_COMMANDS: Record<string, PickerKind> = {
  model: 'model',
  effort: 'effort',
  fast: 'fast'
}

/** The picker a bare slash command opens, or null for a command, or one with arguments, that goes to the harness. */
export function pickerForCommand(name: string, args: string): PickerKind | null {
  if (args !== '') return null
  const kind = PICKER_COMMANDS[name]
  if (kind === undefined) return null
  return kind
}

/** The command names that open a picker, so completion offers them whether or not the harness lists them. */
export function pickerCommandNames(): string[] {
  return Object.keys(PICKER_COMMANDS)
}

/** What can take the keyboard in an open picker: its search field and its enabled rows. */
export function pickerStops(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>('input, button')
  return Array.from(candidates).filter((candidate) => {
    return !(candidate instanceof HTMLButtonElement && candidate.disabled)
  })
}

/** Moves the keyboard one stop along in the picker; false when it is already at that end. */
export function stepPickerFocus(root: HTMLElement, direction: 1 | -1): boolean {
  const stops = pickerStops(root)
  const current = stops.findIndex((stop) => stop === document.activeElement)
  const target = current + direction
  if (current === -1 || target < 0 || target >= stops.length) return false
  stops[target].focus()
  return true
}

/** Puts the keyboard where picking starts: the search field, else the row in use, else the first row, else the picker itself. */
export function focusPickerStart(root: HTMLElement): void {
  const search = root.querySelector<HTMLElement>('input')
  if (search) {
    search.focus()
    return
  }
  const stops = pickerStops(root)
  const current = stops.find((stop) => stop.dataset.current === 'true')
  const target = current ?? stops[0]
  if (target === undefined) {
    root.focus()
    return
  }
  target.focus()
}
