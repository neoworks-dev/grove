// CodeMirror 6 setup. Replaces Monaco: a modular, plugin-native editor that
// pairs well with real Vim bindings (@replit/codemirror-vim). Everything here
// is pure-data — language resolvers, a theme built from the app's ThemePalette,
// and the base extension set — so both the editor and the diff view share it.

import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  StreamLanguage
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags, type Tag } from '@lezer/highlight'

import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { go } from '@codemirror/legacy-modes/mode/go'
import { toml } from '@codemirror/legacy-modes/mode/toml'

import type { ThemePalette } from './themes'
import { resolveHighlighter } from './highlighters'

// ── Language resolution ─────────────────────────────────────────
// Registry of file-extension → language-extension loader. New languages are a
// one-line addition (plugin-friendly), matching the rest of the app's design.
const LANGUAGES: Record<string, () => Extension> = {
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  json: () => json(),
  html: () => html(),
  svelte: () => html(),
  vue: () => html(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  rs: () => rust(),
  yml: () => yaml(),
  yaml: () => yaml(),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  go: () => StreamLanguage.define(go),
  toml: () => StreamLanguage.define(toml)
}

export function languageExtension(path: string): Extension {
  // Installed highlighter plugins (tree-sitter grammars) take priority; Lezer is
  // the built-in fallback.
  const override = resolveHighlighter(path)
  if (override) return override
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const loader = LANGUAGES[ext]
  return loader ? loader() : []
}

// ── Theme ───────────────────────────────────────────────────────
// Build a CodeMirror theme from a ThemePalette. Unlike Monaco (one global
// theme), CM themes are per-instance extensions, so the editor and diff view
// re-configure independently when the app theme changes.
export function editorTheme(palette: ThemePalette, scheme: 'dark' | 'light'): Extension {
  const theme = EditorView.theme(
    {
      '&': {
        color: palette.text,
        backgroundColor: palette.bg,
        // Match the surrounding UI text (--text-xs) rather than running larger.
        fontSize: 'var(--text-xs)',
        height: '100%'
      },
      '.cm-content': {
        fontFamily: "'Geist Mono', monospace",
        caretColor: palette.text
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.text },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: palette.surfaceHover },
      '.cm-gutters': {
        backgroundColor: palette.bg,
        color: palette.textFaint,
        border: 'none'
      },
      '.cm-activeLineGutter': {
        backgroundColor: palette.surface,
        color: palette.textMuted
      },
      '.cm-activeLine': { backgroundColor: palette.bgElevated },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
      '.cm-foldPlaceholder': {
        backgroundColor: palette.surface,
        border: `1px solid ${palette.border}`,
        color: palette.textMuted
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: palette.surfaceHover,
        outline: `1px solid ${palette.borderStrong}`
      },
      '.cm-selectionMatch': { backgroundColor: palette.surfaceHover },
      '.cm-panels': { backgroundColor: palette.surface, color: palette.text },
      '.cm-searchMatch': { backgroundColor: palette.ctxAmber, color: palette.textInverse },
      '.cm-scroller': { fontFamily: "'Geist Mono', monospace" }
    },
    { dark: scheme === 'dark' }
  )

  const highlight = HighlightStyle.define(tokenColorSpecs(palette))

  return [theme, syntaxHighlighting(highlight)]
}

// One spec per token family: the tag→color table shared by the editor's
// HighlightStyle and the minimap renderer, so both always agree on colors.
export interface TokenColorSpec {
  tag: Tag | Tag[]
  color?: string
  fontStyle?: string
  fontWeight?: string
  textDecoration?: string
}

export function tokenColorSpecs(palette: ThemePalette): TokenColorSpec[] {
  return [
    {
      tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword, tags.operatorKeyword],
      color: palette.ctxViolet
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: palette.ctxGreen },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: palette.ctxAmber },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: palette.textDim,
      fontStyle: 'italic'
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: palette.ctxBlue
    },
    { tag: [tags.typeName, tags.className, tags.namespace], color: palette.ctxBlue },
    { tag: [tags.propertyName, tags.attributeName], color: palette.ctxBlue },
    { tag: [tags.tagName], color: palette.ctxViolet },
    {
      tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator],
      color: palette.textMuted
    },
    { tag: [tags.definition(tags.variableName), tags.variableName], color: palette.text },
    { tag: [tags.heading], color: palette.text, fontWeight: 'bold' },
    { tag: [tags.link, tags.url], color: palette.ctxBlue, textDecoration: 'underline' },
    // Markdown inline styles.
    { tag: tags.strong, color: palette.text, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.monospace, color: palette.ctxGreen },
    { tag: tags.quote, color: palette.textMuted, fontStyle: 'italic' },
    { tag: [tags.processingInstruction, tags.list], color: palette.ctxViolet },
    { tag: tags.contentSeparator, color: palette.textDim },
    { tag: [tags.invalid], color: palette.ctxRed }
  ]
}

// ── Base extension set ──────────────────────────────────────────
// The non-language, non-theme extensions shared by every editor instance.
// `onSave` wires Ctrl/Cmd+S; Vim is added by the caller (before this set) so its
// keymap takes precedence.
export function baseExtensions(onSave: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorState.allowMultipleSelections.of(true),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap
    ])
  ]
}
