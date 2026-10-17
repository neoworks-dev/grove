//! Inlay hints: the names of parameters and the types a server infers, shown inside the line.

use editor_core::decorations::{DecorationKind, Tone};
use editor_core::{Buffer, Decoration, Utf16Point};
use serde_json::{Value, json};

use crate::protocol::{Position, Range};

/// The name the editor's decoration set for inlay hints goes by.
pub const INLAY_SOURCE: &str = "lsp.inlayHints";

/// One hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hint {
    pub position: Position,
    pub text: String,
}

/// Reads the answer to an inlay hint request. A hint's label is a text or a list of parts, and
/// the padding it asks for becomes spaces around the text.
pub fn parse_hints(result: &Value) -> Vec<Hint> {
    let Some(list) = result.as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(parse_hint).collect()
}

/// One hint of the answer.
fn parse_hint(entry: &Value) -> Option<Hint> {
    let position: Position = serde_json::from_value(entry["position"].clone()).ok()?;
    let label = match &entry["label"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| part["value"].as_str()).collect(),
        _ => return None,
    };
    if label.is_empty() {
        return None;
    }
    // A type annotation hugs the name it follows, as in the code it stands for.
    let pads_left = entry["paddingLeft"].as_bool().unwrap_or(false) && !label.starts_with(':');
    let left = if pads_left { " " } else { "" };
    let right = if entry["paddingRight"].as_bool().unwrap_or(false) { " " } else { "" };
    Some(Hint { position, text: format!("{left}{label}{right}") })
}

/// The decorations that show the hints in a document.
pub fn decorations_for(buffer: &Buffer, hints: &[Hint]) -> Vec<Decoration> {
    hints
        .iter()
        .map(|hint| {
            let offset = buffer
                .offset_of_utf16_point(Utf16Point { line: hint.position.line, character: hint.position.character });
            Decoration {
                start: buffer.position_of(offset),
                end: None,
                tooltip: None,
                kind: DecorationKind::Inlay { text: hint.text.clone(), tone: Some(Tone::Inlay) },
            }
        })
        .collect()
}

/// The parameters of a request for the hints of some rows, which are the lines `first..=last`.
pub fn request_params(uri: &str, buffer: &Buffer, first: usize, last: usize) -> Value {
    let last = last.min(buffer.line_count().saturating_sub(1));
    let end_offset = buffer.offset_of(editor_core::Position { row: last, column: buffer.line_length(last) });
    let end = buffer.utf16_point_of(end_offset);
    let range = Range {
        start: Position { line: first, character: 0 },
        end: Position { line: end.line, character: end.character },
    };
    json!({ "textDocument": { "uri": uri }, "range": range })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_joined_and_padding_becomes_spaces() {
        let hints = parse_hints(&json!([
            { "position": { "line": 0, "character": 5 }, "label": ": number", "paddingLeft": false },
            { "position": { "line": 1, "character": 2 }, "label": [{ "value": "name" }, { "value": ":" }], "paddingRight": true },
            { "position": { "line": 2, "character": 0 }, "label": "" },
            { "position": { "line": 3, "character": 0 }, "label": ": T", "paddingLeft": true },
            { "position": { "line": 4, "character": 0 }, "label": "-> T", "paddingLeft": true },
        ]));
        assert_eq!(hints.len(), 4);
        assert_eq!(hints[2].text, ": T");
        assert_eq!(hints[3].text, " -> T");
        assert_eq!(hints[0].text, ": number");
        assert_eq!(hints[1].text, "name: ");
    }

    #[test]
    fn hints_sit_at_utf16_columns_as_inlays() {
        let buffer = Buffer::from_text("a😀b = 1\n");
        let hints = vec![Hint { position: Position { line: 0, character: 4 }, text: ": T".into() }];
        let decorations = decorations_for(&buffer, &hints);
        assert_eq!(decorations[0].start, editor_core::Position { row: 0, column: 3 });
        assert!(matches!(&decorations[0].kind, DecorationKind::Inlay { text, .. } if text == ": T"));
    }

    #[test]
    fn the_request_covers_whole_lines() {
        let buffer = Buffer::from_text("one\ntwo é\nthree\n");
        let params = request_params("file:///a.ts", &buffer, 1, 1);
        assert_eq!(params["range"]["start"], json!({ "line": 1, "character": 0 }));
        assert_eq!(params["range"]["end"], json!({ "line": 1, "character": 5 }));
        let beyond = request_params("file:///a.ts", &buffer, 0, 99);
        assert_eq!(beyond["range"]["end"]["line"], 3);
    }
}
