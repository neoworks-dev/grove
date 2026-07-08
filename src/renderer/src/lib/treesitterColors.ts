// Map a tree-sitter highlight capture name (e.g. "keyword.control",
// "function.builtin") to a theme color. Pure + testable — the WASM bridge in
// treesitter.ts uses it to color decorations. Capture names follow the common
// nvim-treesitter / tree-sitter highlight convention.

import type { ThemePalette } from './themes'

export function colorForCapture(name: string, palette: ThemePalette): string | null {
  // Full-name special cases first (base word alone would mislead).
  if (name.startsWith('variable.builtin') || name.startsWith('constant.builtin')) {
    return palette.ctxAmber
  }
  if (name.startsWith('string.escape') || name === 'escape') return palette.ctxAmber

  const base = name.split('.')[0]
  switch (base) {
    case 'keyword':
    case 'conditional':
    case 'repeat':
    case 'include':
    case 'exception':
    case 'storageclass':
    case 'keyword_operator':
      return palette.ctxViolet
    case 'string':
    case 'character':
      return palette.ctxGreen
    case 'number':
    case 'float':
    case 'boolean':
    case 'constant':
      return palette.ctxAmber
    case 'comment':
      return palette.textDim
    case 'function':
    case 'method':
    case 'constructor':
      return palette.ctxBlue
    case 'type':
    case 'namespace':
    case 'module':
      return palette.ctxBlue
    case 'property':
    case 'field':
    case 'attribute':
      return palette.ctxBlue
    case 'variable':
    case 'parameter':
      return palette.text
    case 'operator':
    case 'punctuation':
      return palette.textMuted
    case 'tag':
      return palette.ctxViolet
    case 'label':
      return palette.ctxAmber
    default:
      return null
  }
}
