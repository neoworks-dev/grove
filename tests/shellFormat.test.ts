// Laying a shell command out for reading.
//
// What runs is never this string, so the only thing that matters is that the
// layout follows the command's real structure: an operator inside quotes or a
// substitution is part of an argument, and a loop's `;` is not a statement
// boundary to break at.

import { beforeAll, describe, expect, test } from 'bun:test'
import { Language, Parser } from 'web-tree-sitter'
import { layoutShellCommand } from '../src/renderer/src/lib/shellFormat'

const LONG_PREFIX = 'rg --json --smart-case --hidden --glob !node_modules'

let parser: Parser

beforeAll(async () => {
  await Parser.init()
  const bash = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
  parser = new Parser()
  parser.setLanguage(bash)
})

/** The command laid out the way the renderer lays it out, from a real parse. */
function layout(command: string, inlineLimit?: number): string {
  const tree = parser.parse(command.trim())
  if (!tree) throw new Error('bash did not parse')
  try {
    return layoutShellCommand(command, tree.rootNode, inlineLimit)
  } finally {
    tree.delete()
  }
}

/** Lines of a laid-out command. */
function lines(command: string, inlineLimit?: number): string[] {
  return layout(command, inlineLimit).split('\n')
}

describe('layoutShellCommand', () => {
  test('a command that reads fine on one line is left alone', () => {
    expect(layout('git status --short')).toBe('git status --short')
  })

  test('a long pipeline breaks after each pipe, the stages indented under the first', () => {
    expect(lines(`${LONG_PREFIX} pattern . | head -40 | sort -u`)).toEqual([
      `${LONG_PREFIX} pattern . |`,
      '  head -40 |',
      '  sort -u'
    ])
  })

  test('statements go on lines of their own, and a chain breaks after && and ||', () => {
    expect(
      lines(`${LONG_PREFIX} one . && echo done || echo failed; echo really-truly-done`)
    ).toEqual([
      `${LONG_PREFIX} one . &&`,
      '  echo done ||',
      '  echo failed',
      'echo really-truly-done'
    ])
  })

  test('an operator inside quotes is part of the argument', () => {
    expect(lines(`${LONG_PREFIX} 'alpha | beta' . | wc -l`)).toEqual([
      `${LONG_PREFIX} 'alpha | beta' . |`,
      '  wc -l'
    ])
  })

  test('an escaped operator is not a break either', () => {
    expect(lines(`${LONG_PREFIX} . \\| something | wc -l`)).toEqual([
      `${LONG_PREFIX} . \\| something |`,
      '  wc -l'
    ])
  })

  test('a for loop keeps do with its header, and indents its body', () => {
    expect(lines('for f in *; do echo "$f"; done', 0)).toEqual([
      'for f in *; do',
      '  echo "$f"',
      'done'
    ])
  })

  test('a chain inside a loop body breaks, indented under the body', () => {
    expect(
      lines('while read -r line; do test -n "$line" && echo "$line"; done < list.txt', 0)
    ).toEqual([
      'while read -r line; do',
      '  test -n "$line" &&',
      '    echo "$line"',
      'done < list.txt'
    ])
  })

  test('if, elif and else each head their own branch', () => {
    expect(
      lines('if [ -f a ]; then cat a; elif [ -f b ]; then cat b; else echo none; fi', 0)
    ).toEqual([
      'if [ -f a ]; then',
      '  cat a',
      'elif [ -f b ]; then',
      '  cat b',
      'else',
      '  echo none',
      'fi'
    ])
  })

  test('a case lays out each pattern with its body and terminator under it', () => {
    expect(lines('case "$1" in start|up) run;; *) echo usage;; esac', 0)).toEqual([
      'case "$1" in',
      '  start|up)',
      '    run',
      '    ;;',
      '  *)',
      '    echo usage',
      '    ;;',
      'esac'
    ])
  })

  test('a function body is indented inside its braces', () => {
    expect(lines('greet() { echo hi; echo there; }; greet', 0)).toEqual([
      'greet() {',
      '  echo hi',
      '  echo there',
      '}',
      'greet'
    ])
  })

  test('substitutions, subshells and groups are left whole', () => {
    expect(lines('echo "$(date; whoami)" && (cd .. && ls) && { a; b; }', 0)).toEqual([
      'echo "$(date; whoami)" &&',
      '  (cd .. && ls) &&',
      '  { a; b; }'
    ])
  })

  test('a backgrounded command keeps its & on its own line', () => {
    expect(lines('sleep 5 & wait', 0)).toEqual(['sleep 5 &', 'wait'])
  })

  test('an inline limit of 0 leaves a single command whole', () => {
    expect(layout('git status --short', 0)).toBe('git status --short')
  })

  test('a command the model laid out itself is left as written', () => {
    const command = `cat <<'EOF' > /tmp/x\nline one | not a pipe\nEOF`

    expect(layout(command)).toBe(command)
  })

  test('a command that does not parse is left as written', () => {
    const command = `${LONG_PREFIX} one . && (unclosed | subshell`

    expect(layout(command)).toBe(command)
  })

  test('a long command with nothing to break stays one line', () => {
    const command = `${LONG_PREFIX} a-very-long-single-argument-with-no-operators-at-all .`

    expect(layout(command)).toBe(command)
  })

  test('without a parser, a command is shown as written', () => {
    const command = `${LONG_PREFIX} pattern . | head -40`

    expect(layoutShellCommand(command, null)).toBe(command)
  })
})
