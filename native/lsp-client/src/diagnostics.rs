//! Diagnostics as decorations: a line under the text each one is about, coloured by how bad it
//! is, and a dot beside the line numbers of every line with an error or a warning.

use std::collections::HashMap;

use editor_core::decorations::{DecorationKind, GutterMark, Tone, Underline, UnderlineKind};
use editor_core::{Buffer, Decoration, Position, Utf16Point};

use crate::protocol::{Diagnostic, Range, Severity};

/// The name the editor's decoration set for language server diagnostics goes by.
pub const DIAGNOSTICS_SOURCE: &str = "lsp.diagnostics";

/// The decorations for the diagnostics of a document, positioned against its text as it is now.
pub fn decorations_for(buffer: &Buffer, diagnostics: &[Diagnostic]) -> Vec<Decoration> {
    let mut decorations = Vec::new();
    let mut worst_per_row: HashMap<usize, Severity> = HashMap::new();
    for diagnostic in diagnostics {
        let severity = Severity::from_number(diagnostic.severity);
        let (start, end) = editor_range(buffer, &diagnostic.range);
        decorations.push(underline(start, end, severity, tooltip(diagnostic)));
        let worst = worst_per_row.entry(start.row).or_insert(severity);
        if rank(severity) < rank(*worst) {
            *worst = severity;
        }
    }
    let mut rows: Vec<(usize, Severity)> = worst_per_row.into_iter().collect();
    rows.sort_by_key(|(row, _)| *row);
    for (row, severity) in rows {
        if let Some(tone) = dot_tone(severity) {
            decorations.push(dot(row, tone));
        }
    }
    decorations
}

/// The range a diagnostic covers in the editor's positions. An empty range is widened to the
/// word it is in, or one character, so there is something to underline.
pub fn editor_range(buffer: &Buffer, range: &Range) -> (Position, Position) {
    let start = offset_of(buffer, range.start.line, range.start.character);
    let end = offset_of(buffer, range.end.line, range.end.character).max(start);
    if start != end {
        return (buffer.position_of(start), buffer.position_of(end));
    }
    let (start, end) = widen_empty(buffer, start);
    (buffer.position_of(start), buffer.position_of(end))
}

/// The character offset of a line and UTF-16 column.
fn offset_of(buffer: &Buffer, line: usize, character: usize) -> usize {
    buffer.offset_of_utf16_point(Utf16Point { line, character })
}

/// The word around an offset, or the character after it, or the one before it at the end of a line.
fn widen_empty(buffer: &Buffer, offset: usize) -> (usize, usize) {
    let position = buffer.position_of(offset);
    let line: Vec<char> = buffer.line(position.row).chars().collect();
    let line_start = offset - position.column;
    let is_word =
        |index: usize| line.get(index).is_some_and(|character| character.is_alphanumeric() || *character == '_');
    if is_word(position.column) {
        let mut end = position.column;
        while is_word(end) {
            end += 1;
        }
        return (offset, line_start + end);
    }
    if position.column < line.len() {
        return (offset, offset + 1);
    }
    if position.column > 0 {
        return (offset - 1, offset);
    }
    (offset, offset)
}

/// How bad a severity is; lower is worse.
fn rank(severity: Severity) -> u8 {
    match severity {
        Severity::Error => 0,
        Severity::Warning => 1,
        Severity::Information => 2,
        Severity::Hint => 3,
    }
}

/// The tone a severity is drawn in.
pub fn tone_of(severity: Severity) -> Tone {
    match severity {
        Severity::Error => Tone::Error,
        Severity::Warning => Tone::Warning,
        Severity::Information => Tone::Info,
        Severity::Hint => Tone::Hint,
    }
}

/// The tone of a gutter dot, for the severities that get one.
fn dot_tone(severity: Severity) -> Option<Tone> {
    match severity {
        Severity::Error | Severity::Warning => Some(tone_of(severity)),
        Severity::Information | Severity::Hint => None,
    }
}

/// The line under a diagnostic's range: a squiggle, or a plain line for a hint.
fn underline(start: Position, end: Position, severity: Severity, tooltip: String) -> Decoration {
    let style = if severity == Severity::Hint { UnderlineKind::Line } else { UnderlineKind::Squiggle };
    Decoration {
        start,
        end: Some(end),
        tooltip: Some(tooltip),
        kind: DecorationKind::Highlight {
            background: None,
            underline: Some(Underline { style, tone: tone_of(severity) }),
        },
    }
}

/// The dot beside a line's number.
fn dot(row: usize, tone: Tone) -> Decoration {
    Decoration {
        start: Position { row, column: 0 },
        end: None,
        tooltip: None,
        kind: DecorationKind::Gutter { mark: GutterMark::Dot, tone: Some(tone) },
    }
}

/// What the diagnostic says when the pointer rests on it: the message, then where it came from.
fn tooltip(diagnostic: &Diagnostic) -> String {
    let origin = origin_of(diagnostic);
    if origin.is_empty() {
        return diagnostic.message.clone();
    }
    format!("{}\n\n*{origin}*", diagnostic.message)
}

/// The source of a diagnostic and its code, such as `rustc(E0308)`.
fn origin_of(diagnostic: &Diagnostic) -> String {
    let source = diagnostic.source.clone().unwrap_or_default();
    let code = match &diagnostic.code {
        Some(serde_json::Value::String(code)) => code.clone(),
        Some(serde_json::Value::Number(code)) => code.to_string(),
        _ => String::new(),
    };
    if code.is_empty() {
        return source;
    }
    if source.is_empty() {
        return code;
    }
    format!("{source}({code})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Position as LspPosition;
    use editor_core::{Command, EditorState};

    fn diagnostic(severity: Option<u8>, start: (usize, usize), end: (usize, usize), message: &str) -> Diagnostic {
        Diagnostic {
            range: Range {
                start: LspPosition { line: start.0, character: start.1 },
                end: LspPosition { line: end.0, character: end.1 },
            },
            severity,
            code: None,
            source: None,
            message: message.to_string(),
            tags: Vec::new(),
        }
    }

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn a_diagnostic_underlines_its_range_in_its_tone_and_carries_its_message() {
        let buffer = Buffer::from_text("let x: number = \"a\";\n");
        let decorations = decorations_for(&buffer, &[diagnostic(Some(1), (0, 16), (0, 19), "Type 'string'")]);
        assert_eq!(decorations.len(), 2);
        assert_eq!((decorations[0].start, decorations[0].end), (at(0, 16), Some(at(0, 19))));
        assert_eq!(decorations[0].tooltip.as_deref(), Some("Type 'string'"));
        let DecorationKind::Highlight { underline: Some(line), .. } = &decorations[0].kind else {
            panic!("a highlight");
        };
        assert_eq!((line.style, line.tone), (UnderlineKind::Squiggle, Tone::Error));
        assert_eq!(decorations[1].kind, DecorationKind::Gutter { mark: GutterMark::Dot, tone: Some(Tone::Error) });
    }

    #[test]
    fn utf16_columns_become_character_columns() {
        let buffer = Buffer::from_text("a😀bc\n");
        let decorations = decorations_for(&buffer, &[diagnostic(Some(2), (0, 3), (0, 5), "w")]);
        assert_eq!((decorations[0].start, decorations[0].end), (at(0, 2), Some(at(0, 4))));
    }

    #[test]
    fn one_dot_per_row_in_the_colour_of_the_worst_and_none_for_hints() {
        let buffer = Buffer::from_text("abc def\nghi\n");
        let decorations = decorations_for(
            &buffer,
            &[
                diagnostic(Some(2), (0, 0), (0, 3), "warn"),
                diagnostic(Some(1), (0, 4), (0, 7), "error"),
                diagnostic(Some(4), (1, 0), (1, 3), "hint"),
            ],
        );
        let dots: Vec<_> = decorations.iter().filter(|d| matches!(d.kind, DecorationKind::Gutter { .. })).collect();
        assert_eq!(dots.len(), 1);
        assert_eq!(dots[0].kind, DecorationKind::Gutter { mark: GutterMark::Dot, tone: Some(Tone::Error) });
        let hint = decorations.iter().find(|d| d.tooltip.as_deref() == Some("hint")).unwrap();
        let DecorationKind::Highlight { underline: Some(line), .. } = &hint.kind else {
            panic!("a highlight");
        };
        assert_eq!((line.style, line.tone), (UnderlineKind::Line, Tone::Hint));
    }

    #[test]
    fn an_empty_range_widens_to_the_word_or_a_character() {
        let buffer = Buffer::from_text("let foo = 1\n");
        let empty = |column: usize| diagnostic(Some(1), (0, column), (0, column), "m");
        let widened = |column: usize| editor_range(&buffer, &empty(column).range);
        assert_eq!(widened(5), (at(0, 5), at(0, 7)));
        assert_eq!(widened(3), (at(0, 3), at(0, 4)));
        assert_eq!(widened(11), (at(0, 10), at(0, 11)));
    }

    #[test]
    fn the_source_and_code_follow_the_message() {
        let mut found = diagnostic(Some(1), (0, 0), (0, 1), "mismatched types");
        found.source = Some("rustc".into());
        found.code = Some(serde_json::json!("E0308"));
        assert_eq!(tooltip(&found), "mismatched types\n\n*rustc(E0308)*");
        found.code = Some(serde_json::json!(2322));
        found.source = None;
        assert_eq!(origin_of(&found), "2322");
    }

    #[test]
    fn decorations_set_on_a_state_follow_the_text() {
        let mut state = EditorState::new(Buffer::from_text("let x = bad;\n"));
        let decorations = decorations_for(state.buffer(), &[diagnostic(Some(1), (0, 8), (0, 11), "bad")]);
        state.set_decorations(DIAGNOSTICS_SOURCE, &decorations);
        state.apply(&Command::InsertText { text: "// c\n".into() });
        let placed = state.decorations_in_rows(0..3);
        let squiggle = placed.iter().find(|placed| placed.tooltip == Some("bad")).unwrap();
        assert_eq!((squiggle.start, squiggle.end), (at(1, 8), at(1, 11)));
    }
}
