// Recognising the prompts an embedded Neovim has stopped on.
//
// Grove attaches without `ext_messages`, so nvim draws its messages into a
// message grid the compositor places over the bottom of the outer grid. While
// that grid is one row tall it is the cmdline showing a message. The moment it
// grows taller, nvim has stopped mid-command and is waiting for a key — a
// hit-enter prompt, the `-- More --` pager, or a confirm such as W13 ("File
// has been created after editing started"). Nothing else runs in that nvim
// until the key arrives: every msgpack request grove has in flight is stuck
// behind it, which is why the prompt has to be answerable from wherever focus
// happens to be rather than only from the pane that raised it.

import type { MultigridState } from './multigrid'

/**
 * The lines of the prompt this Neovim is blocked on, or null when it is not
 * blocked. The last line is the question; the ones above it are the message
 * that led to it.
 */
export function nvimBlockingPrompt(state: MultigridState): string[] | null {
  const message = [...state.windows.values()].find(
    (placement) => placement.kind === 'message' && !placement.hidden
  )
  if (!message) return null
  if (message.height <= 1) return null
  const grid = state.grids.get(message.grid)
  if (!grid) return null

  const lines: string[] = []
  for (let row = 0; row < message.height; row += 1) {
    const cells = grid.lines[row]
    if (!cells) break
    lines.push(
      cells
        .map((cell) => cell.text)
        .join('')
        .trimEnd()
    )
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  if (lines.length === 0) return null
  return lines
}

export interface NvimPromptChoice {
  // The key that picks this answer, as nvim marked it.
  key: string
  label: string
}

/**
 * The answers a prompt offers, read off its question line — nvim brackets each
 * one's key, as in `[O]K, (L)oad File, Load File (a)nd Options:`. Empty for a
 * prompt that takes any key, such as a hit-enter prompt or the `-- More --`
 * pager.
 */
export function nvimPromptChoices(line: string): NvimPromptChoice[] {
  const choices: NvimPromptChoice[] = []
  for (const segment of line.split(',')) {
    const marked = /[[(]([A-Za-z])[\])]/.exec(segment)
    if (!marked) continue
    const label = segment
      .replace(/[[\]()]/g, '')
      .replace(/:\s*$/, '')
      .trim()
    if (!label) continue
    choices.push({ key: marked[1], label })
  }
  return choices
}
