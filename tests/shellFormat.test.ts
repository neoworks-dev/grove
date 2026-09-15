// Laying a shell command out for reading.
//
// What runs is never this string, so the only thing that matters is that the
// break points are real ones: an operator inside quotes is a character in an
// argument, and breaking there would show a command nobody wrote.

import { describe, expect, test } from 'bun:test'
import { formatShellCommand } from '../src/renderer/src/lib/shellFormat'

const LONG_PREFIX = 'rg --json --smart-case --hidden --glob !node_modules'

describe('formatShellCommand', () => {
  test('a command that reads fine on one line is left alone', () => {
    expect(formatShellCommand('git status --short')).toBe('git status --short')
  })

  test('a long pipeline breaks at its pipes, operator first', () => {
    const command = `${LONG_PREFIX} pattern . | head -40 | sort -u`

    expect(formatShellCommand(command)).toBe(
      [`${LONG_PREFIX} pattern .`, '  | head -40', '  | sort -u'].join('\n')
    )
  })

  test('chains break on && and ;', () => {
    const command = `${LONG_PREFIX} one . && echo done ; echo really-truly-done`

    expect(formatShellCommand(command).split('\n')).toEqual([
      `${LONG_PREFIX} one .`,
      '  && echo done',
      '  ; echo really-truly-done'
    ])
  })

  test('an operator inside quotes is part of the argument', () => {
    const command = `${LONG_PREFIX} 'alpha | beta' . | wc -l`

    expect(formatShellCommand(command).split('\n')).toEqual([
      `${LONG_PREFIX} 'alpha | beta' .`,
      '  | wc -l'
    ])
  })

  test('an escaped operator is not a break either', () => {
    const command = `${LONG_PREFIX} . \\| something | wc -l`

    expect(formatShellCommand(command).split('\n')).toEqual([
      `${LONG_PREFIX} . \\| something`,
      '  | wc -l'
    ])
  })

  test('&& wins over the & inside it', () => {
    const command = `${LONG_PREFIX} one . && ${LONG_PREFIX} two .`

    expect(formatShellCommand(command).split('\n')[1]).toBe(`  && ${LONG_PREFIX} two .`)
  })

  test('a command the model laid out itself is left as written', () => {
    const command = `cat <<'EOF' > /tmp/x\nline one | not a pipe\nEOF`

    expect(formatShellCommand(command)).toBe(command)
  })

  test('a long command with nothing to break stays one line', () => {
    const command = `${LONG_PREFIX} a-very-long-single-argument-with-no-operators-at-all .`

    expect(formatShellCommand(command)).toBe(command)
  })
})
