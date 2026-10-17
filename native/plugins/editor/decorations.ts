// What a plugin can put on top of a document's text. A source (a language server, git, an agent)
// owns a named set and replaces it whole with `EditorService.setDecorations`; the editor pins each
// decoration to the text, so it follows edits, and draws it. The shapes here are the JSON the Rust
// side reads (see `editor-core/src/decorations.rs`), with rows and columns counted from zero.

/** A place in a document: a line, and a character within it. */
export interface TextPosition {
  row: number;
  column: number;
}

/** What a decoration means; the theme turns it into a colour. */
export type Tone = "error" | "warning" | "info" | "hint" | "added" | "modified" | "deleted" | "inlay" | "line_end";

/** A mark beside the line numbers: a bar along the rows, a dot, a notch for deleted lines, or one character. */
export type GutterMark = "bar" | "dot" | "notch" | { glyph: string };

/** Colours a range of text: a background, a line under it, or both. */
export interface HighlightDecoration {
  kind: "highlight";
  start: TextPosition;
  end: TextPosition;
  background?: Tone;
  underline?: { style: "squiggle" | "line"; tone: Tone };
}

/** Text between two characters, which pushes the text after it aside, such as a type hint. */
export interface InlayDecoration {
  kind: "inlay";
  start: TextPosition;
  text: string;
  tone?: Tone;
}

/** Text after the end of the line `start` is on, such as blame. */
export interface LineEndDecoration {
  kind: "line_end";
  start: TextPosition;
  text: string;
  tone?: Tone;
}

/** A mark beside the line numbers on the rows from `start` to `end`. */
export interface GutterDecoration {
  kind: "gutter";
  start: TextPosition;
  end?: TextPosition;
  mark: GutterMark;
  tone?: Tone;
}

/** Whole rows of text above or below the line `start` is on, such as a deleted hunk. */
export interface BlockDecoration {
  kind: "block";
  start: TextPosition;
  lines: string[];
  placement?: "above" | "below";
  tone?: Tone;
}

export type Decoration =
  | HighlightDecoration
  | InlayDecoration
  | LineEndDecoration
  | GutterDecoration
  | BlockDecoration;
