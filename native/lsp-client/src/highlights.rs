//! Document highlights: the other places a server says are the symbol under the cursor.

use editor_core::decorations::{DecorationKind, Tone};
use editor_core::occurrences::SERVER_SOURCE;
use editor_core::{Buffer, Decoration};
use serde_json::Value;

use crate::diagnostics::editor_range;
use crate::protocol::Range;

/// The name the editor's decoration set for the server's highlights goes by.
pub const HIGHLIGHT_SOURCE: &str = SERVER_SOURCE;

/// The ranges in the answer to a highlight request.
pub fn parse_ranges(result: &Value) -> Vec<Range> {
    let Some(list) = result.as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(|entry| serde_json::from_value(entry["range"].clone()).ok()).collect()
}

/// The decorations that mark the ranges as occurrences of the symbol. The place the cursor is on
/// is left out, as it is for the highlights matched as text.
pub fn decorations_for(buffer: &Buffer, ranges: &[Range], cursor: editor_core::Position) -> Vec<Decoration> {
    let mut decorations = Vec::new();
    for range in ranges {
        let (start, end) = editor_range(buffer, range);
        if start <= cursor && cursor <= end {
            continue;
        }
        decorations.push(Decoration {
            start,
            end: Some(end),
            tooltip: None,
            kind: DecorationKind::Highlight { background: Some(Tone::Occurrence), underline: None },
        });
    }
    decorations
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_symbol_under_the_cursor_is_not_marked_again() {
        let buffer = Buffer::from_text("let size = 1;\nsize += 1;\n");
        let answer = json!([
            { "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 0, "character": 8 } }, "kind": 1 },
            { "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 4 } }, "kind": 2 },
        ]);
        let ranges = parse_ranges(&answer);
        assert_eq!(ranges.len(), 2);
        let marked = decorations_for(&buffer, &ranges, editor_core::Position { row: 0, column: 5 });
        assert_eq!(marked.len(), 1);
        assert_eq!(marked[0].start, editor_core::Position { row: 1, column: 0 });
        assert!(parse_ranges(&Value::Null).is_empty());
    }
}
