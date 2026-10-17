// The colours the native editor paints with, derived from the active theme. `EditorMain.svelte`
// passes the result as the editor element's `theme` prop (documented in `src/editor/theme.rs`), and
// since it reads the active tokens, a theme switch sends a new one and the editor recolours live.
// The window colours come from the theme's tokens; the syntax colours come from a table per scheme,
// keyed by the highlight names in `editor-core`'s `syntax/highlight.rs`, because a theme's palette
// has too few colours to tell keywords, strings and types apart.

import { activeScheme, activeTokens } from "./active";
import type { ThemeTokens } from "./palette";

/** A syntax colour, or one with a weight and slant. */
export type SyntaxStyle = string | { color: string; bold?: boolean; italic?: boolean };

/** What the editor element's `theme` prop carries. */
export interface EditorTheme {
  background: string;
  foreground: string;
  currentLine: string;
  lineNumber: string;
  currentLineNumber: string;
  selection: string;
  cursor: string;
  /** What decorations are drawn in: diagnostics, git changes, inlay hints and text after a line. */
  error: string;
  warning: string;
  info: string;
  hint: string;
  added: string;
  modified: string;
  deleted: string;
  inlay: string;
  lineEnd: string;
  /** Styles by highlight name; a name left out takes its dotted prefix's style, else the foreground. */
  syntax: Record<string, SyntaxStyle>;
}

/** Syntax colours on a dark surface. */
export const DARK_SYNTAX: Record<string, SyntaxStyle> = {
  keyword: "#a78bfa",
  string: "#86efac",
  "string.escape": "#67e8f9",
  "string.regex": "#fca5a5",
  "string.special": "#67e8f9",
  number: "#fbbf24",
  boolean: "#fbbf24",
  constant: "#fbbf24",
  "constant.builtin": "#fbbf24",
  function: "#60a5fa",
  "function.builtin": "#93c5fd",
  "function.macro": "#c4b5fd",
  type: "#5eead4",
  "type.builtin": "#5eead4",
  enum: "#5eead4",
  constructor: "#5eead4",
  module: "#93c5fd",
  property: "#7dd3fc",
  variable: "#e4e4e7",
  "variable.builtin": "#f87171",
  "variable.parameter": "#fdba74",
  attribute: "#fcd34d",
  label: "#fcd34d",
  tag: "#f87171",
  preproc: "#c4b5fd",
  operator: "#a1a1aa",
  punctuation: "#a1a1aa",
  "punctuation.special": "#c4b5fd",
  comment: { color: "#71717a", italic: true },
  "comment.doc": { color: "#8b8b94", italic: true },
  title: { color: "#60a5fa", bold: true },
  emphasis: { color: "#e4e4e7", italic: true },
  "emphasis.strong": { color: "#fafafa", bold: true },
  link_text: "#60a5fa",
  link_uri: { color: "#7dd3fc" },
  "text.literal": "#86efac",
};

/** Syntax colours on a light surface. */
export const LIGHT_SYNTAX: Record<string, SyntaxStyle> = {
  keyword: "#7c3aed",
  string: "#15803d",
  "string.escape": "#0e7490",
  "string.regex": "#b91c1c",
  "string.special": "#0e7490",
  number: "#b45309",
  boolean: "#b45309",
  constant: "#b45309",
  "constant.builtin": "#b45309",
  function: "#2563eb",
  "function.builtin": "#1d4ed8",
  "function.macro": "#6d28d9",
  type: "#0f766e",
  "type.builtin": "#0f766e",
  enum: "#0f766e",
  constructor: "#0f766e",
  module: "#1d4ed8",
  property: "#0369a1",
  variable: "#27272a",
  "variable.builtin": "#dc2626",
  "variable.parameter": "#c2410c",
  attribute: "#a16207",
  label: "#a16207",
  tag: "#dc2626",
  preproc: "#6d28d9",
  operator: "#52525b",
  punctuation: "#52525b",
  "punctuation.special": "#6d28d9",
  comment: { color: "#71717a", italic: true },
  "comment.doc": { color: "#52525b", italic: true },
  title: { color: "#2563eb", bold: true },
  emphasis: { color: "#27272a", italic: true },
  "emphasis.strong": { color: "#09090b", bold: true },
  link_text: "#2563eb",
  link_uri: { color: "#0369a1" },
  "text.literal": "#15803d",
};

/** The editor's colours for a theme's tokens and scheme. */
export function editorThemeFor(tokens: ThemeTokens, scheme: "dark" | "light"): EditorTheme {
  return {
    background: tokens.surface,
    foreground: tokens.text,
    currentLine: tokens.hover,
    lineNumber: tokens.faint,
    currentLineNumber: tokens.muted,
    selection: `${tokens.accent}40`,
    cursor: tokens.accent,
    error: tokens.red,
    warning: tokens.amber,
    info: tokens.blue,
    hint: tokens.muted,
    added: tokens.green,
    modified: tokens.blue,
    deleted: tokens.red,
    inlay: tokens.muted,
    lineEnd: tokens.dim,
    syntax: scheme === "dark" ? DARK_SYNTAX : LIGHT_SYNTAX,
  };
}

/** The editor's colours for the theme in use. Reactive, so reading it in markup follows a theme switch. */
export function activeEditorTheme(): EditorTheme {
  return editorThemeFor(activeTokens(), activeScheme());
}
