// Laying out a shell command so it can be read.
//
// A model writes one line: four greps joined by pipes, a `for` loop, three
// commands chained on `&&`, all of it past the width of any pane it is shown in.
// The command that runs is never touched — this is only how it is displayed, so
// the reader can see where one stage ends and the next begins.
//
// Splitting shell text means knowing what is quoted: a `|` inside 'a | b' is a
// character, not a pipe, and breaking there would misrepresent the command.

/** Operators worth a new line, longest first so `&&` wins over `&`. */
const OPERATORS = ['&&', '||', '|&', '|', ';']

/** Commands shorter than this read fine as one line. */
const INLINE_LIMIT = 72

/** Continuation lines are indented under the first, so stages line up. */
const INDENT = '  '

/**
 * A shell command, broken at its top-level operators.
 *
 * Returns the command unchanged when it is short enough to read as it is, or
 * when it already spans several lines — a heredoc or a script the model laid out
 * itself is already saying how it wants to be read.
 */
export function formatShellCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length <= INLINE_LIMIT) return trimmed
  if (trimmed.includes('\n')) return trimmed

  const stages = splitStages(trimmed).filter((stage) => stage.text.length > 0)
  if (stages.length <= 1) return trimmed

  return stages.map(lineFor).join('\n')
}

/** One run of the command, and the operator that introduced it. */
interface Stage {
  /** Empty for the first stage: nothing introduced it. */
  operator: string
  text: string
}

/**
 * The operator leads its line, which is what makes a pipeline scannable down the
 * left edge; everything after the first is indented under it.
 */
function lineFor(stage: Stage, index: number): string {
  if (index === 0) return stage.text
  return `${INDENT}${stage.operator} ${stage.text}`
}

/** `a | b && c` as `a`, `| b`, `&& c` — splitting only on operators that are operators. */
function splitStages(command: string): Stage[] {
  const stages: Stage[] = []
  const state = { quote: '', escaped: false }
  let operator = ''
  let text = ''
  let index = 0

  while (index < command.length) {
    const character = command[index]
    if (consumesQuoting(character, state)) {
      text += character
      index += 1
      continue
    }

    const found = operatorAt(command, index)
    if (!found) {
      text += character
      index += 1
      continue
    }

    stages.push({ operator, text: text.trim() })
    operator = found
    text = ''
    index += found.length
  }

  stages.push({ operator, text: text.trim() })
  return stages
}

/** Track quoting, and say whether this character is part of it rather than syntax. */
function consumesQuoting(character: string, state: { quote: string; escaped: boolean }): boolean {
  if (state.escaped) {
    state.escaped = false
    return true
  }
  if (character === '\\') {
    state.escaped = true
    return true
  }
  if (state.quote) {
    if (character === state.quote) state.quote = ''
    return true
  }
  if (character === '"' || character === "'") {
    state.quote = character
    return true
  }
  return false
}

/** The operator starting at this position, if one does. */
function operatorAt(command: string, index: number): string | null {
  for (const operator of OPERATORS) {
    if (command.startsWith(operator, index)) return operator
  }
  return null
}
