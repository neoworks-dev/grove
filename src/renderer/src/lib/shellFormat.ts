// Laying out a shell command so it can be read.
//
// A model writes one line: four greps joined by pipes, a `for` loop, three
// commands chained on `&&`, all of it past the width of any pane it is shown in.
// The command that runs is never touched — this is only how it is displayed.
//
// The layout is printed from the command's syntax tree (tree-sitter-bash), the
// way shfmt prints a script: one statement per line, `&&`, `||` and `|` ending
// the line they continue, and the bodies of loops, conditionals, cases and
// functions indented under their header. Anything else — a simple command, a
// `$(…)`, a `( … )` subshell, a `{ …; }` group — is printed as it was written,
// since breaking it open would show structure the reader did not ask about.

import type { Node } from 'web-tree-sitter'

/** Commands shorter than this read fine as one line. */
const INLINE_LIMIT = 72

/** One level of indentation, for bodies and for the lines a chain continues on. */
const INDENT = '  '

/** The chains that break after their operator. */
const CHAIN_TYPES = new Set(['list', 'pipeline'])

/** Compound commands whose bodies are laid out, one statement per line. */
const BLOCK_TYPES = new Set([
  'for_statement',
  'c_style_for_statement',
  'while_statement',
  'if_statement',
  'case_statement',
  'function_definition'
])

/**
 * A shell command, laid out from its syntax tree.
 *
 * Returns the command unchanged when it is short enough to read as it is, when
 * it already spans several lines — a heredoc or a script the model laid out
 * itself is already saying how it wants to be read — or when there is no tree
 * to lay it out from, or the tree does not parse cleanly. An approval passes an
 * `inlineLimit` of 0, since every stage there is something being agreed to.
 */
export function layoutShellCommand(
  command: string,
  root: Node | null,
  inlineLimit = INLINE_LIMIT
): string {
  const trimmed = command.trim()
  if (trimmed.length <= inlineLimit) return trimmed
  if (trimmed.includes('\n')) return trimmed
  if (!root || root.hasError) return trimmed

  return statementLines(root, 0).join('\n')
}

/** The lines of a node that holds statements: a program, a loop body, a branch. */
function statementLines(parent: Node, depth: number, children = parent.children): string[] {
  const lines: string[] = []
  for (const child of children) {
    if (!child) continue
    if (child.type === '&') {
      // Backgrounding belongs to the statement before it, on the same line.
      appendToLast(lines, ' &')
      continue
    }
    if (!child.isNamed) continue
    lines.push(...nodeLines(child, depth))
  }
  return lines
}

/** A statement's lines, indented to its depth. */
function nodeLines(node: Node, depth: number): string[] {
  if (CHAIN_TYPES.has(node.type)) return chainLines(node, depth)
  if (node.type === 'redirected_statement') return redirectedLines(node, depth)
  if (node.type === 'for_statement' || node.type === 'c_style_for_statement') {
    return loopLines(node, depth)
  }
  if (node.type === 'while_statement') return loopLines(node, depth)
  if (node.type === 'if_statement') return ifLines(node, depth)
  if (node.type === 'case_statement') return caseLines(node, depth)
  if (node.type === 'function_definition') return functionLines(node, depth)
  return [indentOf(depth) + node.text]
}

/**
 * `a && b | c`, one operand per line: the operator ends the line it continues,
 * and every operand after the first is indented under the first.
 */
function chainLines(node: Node, depth: number): string[] {
  const { operands, operators } = flattenChain(node)
  const lines: string[] = []
  operands.forEach((operand, index) => {
    let operandDepth = depth
    if (index > 0) operandDepth = depth + 1
    const operandLines = nodeLines(operand, operandDepth)
    if (index > 0) appendToLast(lines, ` ${operators[index - 1]}`)
    lines.push(...operandLines)
  })
  return lines
}

/**
 * A chain's operands in order, and the operator between each pair.
 *
 * tree-sitter nests `a && b || c` to the left and a pipeline inside a list, so
 * a chain of one kind of node is unrolled; a pipeline inside a list is unrolled
 * with it, since every stage is a step in the same line of work.
 */
function flattenChain(node: Node): { operands: Node[]; operators: string[] } {
  const operands: Node[] = []
  const operators: string[] = []
  for (const child of node.children) {
    if (!child) continue
    if (!child.isNamed) {
      operators.push(child.type)
      continue
    }
    if (!CHAIN_TYPES.has(child.type)) {
      operands.push(child)
      continue
    }
    const inner = flattenChain(child)
    operands.push(...inner.operands)
    operators.push(...inner.operators)
  }
  return { operands, operators }
}

/** `while read l; do …; done < file`: the statement laid out, its redirects after it. */
function redirectedLines(node: Node, depth: number): string[] {
  const body = node.childForFieldName('body')
  if (!body || !BLOCK_TYPES.has(body.type)) return [indentOf(depth) + node.text]

  const lines = nodeLines(body, depth)
  const redirects = node.text.slice(body.endIndex - node.startIndex).trim()
  if (redirects.length > 0) appendToLast(lines, ` ${redirects}`)
  return lines
}

/** `for …; do` or `while …; do`, the body indented, then `done`. */
function loopLines(node: Node, depth: number): string[] {
  const body = node.childForFieldName('body')
  if (!body || body.type !== 'do_group') return [indentOf(depth) + node.text]

  const header = headerText(node, body)
  return [
    `${indentOf(depth)}${header}; do`,
    ...statementLines(body, depth + 1, withoutKeywords(body.children, ['do', 'done'])),
    `${indentOf(depth)}done`
  ]
}

/** `if …; then`, each branch's body indented under it, then `fi`. */
function ifLines(node: Node, depth: number): string[] {
  const lines: string[] = []
  const children = childrenOf(node)
  const thenIndex = children.findIndex((child) => child.type === 'then')
  if (thenIndex === -1) return [indentOf(depth) + node.text]

  lines.push(`${indentOf(depth)}if ${conditionText(children.slice(1, thenIndex))}; then`)
  const rest = children.slice(thenIndex + 1)
  const firstBranch = rest.findIndex((child) => isBranch(child) || child.type === 'fi')
  lines.push(...statementLines(node, depth + 1, rest.slice(0, firstBranch)))

  for (const branch of rest.slice(firstBranch)) {
    if (branch.type === 'elif_clause') lines.push(...elifLines(branch, depth))
    if (branch.type === 'else_clause') lines.push(...elseLines(branch, depth))
  }
  lines.push(`${indentOf(depth)}fi`)
  return lines
}

/** `elif …; then` and the body under it. */
function elifLines(node: Node, depth: number): string[] {
  const children = childrenOf(node)
  const thenIndex = children.findIndex((child) => child.type === 'then')
  const condition = conditionText(children.slice(1, thenIndex))
  return [
    `${indentOf(depth)}elif ${condition}; then`,
    ...statementLines(node, depth + 1, children.slice(thenIndex + 1))
  ]
}

/** `else` and the body under it. */
function elseLines(node: Node, depth: number): string[] {
  return [
    `${indentOf(depth)}else`,
    ...statementLines(node, depth + 1, withoutKeywords(childrenOf(node), ['else']))
  ]
}

/** `case … in`, each pattern indented under it and its body under that, then `esac`. */
function caseLines(node: Node, depth: number): string[] {
  const children = childrenOf(node)
  const inIndex = children.findIndex((child) => child.type === 'in')
  if (inIndex === -1) return [indentOf(depth) + node.text]

  const header = node.text.slice(0, children[inIndex].endIndex - node.startIndex)
  const lines = [indentOf(depth) + header]
  for (const item of children.filter((child) => child.type === 'case_item')) {
    lines.push(...caseItemLines(item, depth + 1))
  }
  lines.push(`${indentOf(depth)}esac`)
  return lines
}

/** `pattern)`, the body under it, and the `;;` that ends it. */
function caseItemLines(node: Node, depth: number): string[] {
  const children = childrenOf(node)
  const closeIndex = children.findIndex((child) => child.type === ')')
  if (closeIndex === -1) return [indentOf(depth) + node.text]

  const pattern = node.text.slice(0, children[closeIndex].endIndex - node.startIndex)
  const body = children.slice(closeIndex + 1)
  const terminator = body.find((child) => isCaseTerminator(child.type))
  const lines = [indentOf(depth) + pattern, ...statementLines(node, depth + 1, body)]
  if (terminator) lines.push(indentOf(depth + 1) + terminator.type)
  return lines
}

/** `name() {`, the body indented, then `}`. */
function functionLines(node: Node, depth: number): string[] {
  const body = node.childForFieldName('body')
  if (!body || body.type !== 'compound_statement') return [indentOf(depth) + node.text]

  return [
    `${indentOf(depth)}${headerText(node, body)} {`,
    ...statementLines(body, depth + 1, withoutKeywords(body.children, ['{', '}'])),
    `${indentOf(depth)}}`
  ]
}

/** What comes before a compound command's body, without the `;` that ends it. */
function headerText(node: Node, body: Node): string {
  return node.text
    .slice(0, body.startIndex - node.startIndex)
    .trim()
    .replace(/;$/, '')
    .trim()
}

/** A condition as written, from its first node to its last, without the `;` after it. */
function conditionText(nodes: Node[]): string {
  const named = nodes.filter((child) => child.isNamed)
  if (named.length === 0) return ''
  const source = named[0].tree.rootNode.text
  return source.slice(named[0].startIndex, named[named.length - 1].endIndex)
}

/** A node's children, without the nulls web-tree-sitter's typing allows for. */
function childrenOf(node: Node): Node[] {
  return node.children.filter((child): child is Node => child !== null)
}

/** Children, less the keywords that open and close their block. */
function withoutKeywords(children: (Node | null)[], keywords: string[]): Node[] {
  return children.filter((child): child is Node => child !== null && !keywords.includes(child.type))
}

/** An `elif` or `else` branch. */
function isBranch(node: Node): boolean {
  return node.type === 'elif_clause' || node.type === 'else_clause'
}

/** `;;`, and the fall-through forms bash adds to it. */
function isCaseTerminator(type: string): boolean {
  return type === ';;' || type === ';&' || type === ';;&'
}

/** Add text to the end of the last line, when there is one. */
function appendToLast(lines: string[], text: string): void {
  if (lines.length === 0) return
  lines[lines.length - 1] += text
}

/** The indentation for a depth. */
function indentOf(depth: number): string {
  return INDENT.repeat(depth)
}
