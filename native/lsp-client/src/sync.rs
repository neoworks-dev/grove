//! The notifications that keep a server's copy of a document in step with the editor's.

use editor_core::ContentChange;
use serde_json::{Value, json};

use crate::protocol::SyncKind;

/// `textDocument/didOpen`: the document as it is now.
pub fn did_open_params(uri: &str, language_id: &str, version: i64, text: &str) -> Value {
    json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": version, "text": text } })
}

/// `textDocument/didChange` for changes made to the text, or none when the server does not want
/// to hear of changes or there are none. A server that wants the whole text gets it from
/// `full_text`, which is only called then.
pub fn did_change_params(
    uri: &str,
    version: i64,
    sync: SyncKind,
    changes: &[ContentChange],
    full_text: impl FnOnce() -> String,
) -> Option<Value> {
    if changes.is_empty() {
        return None;
    }
    let content_changes = match sync {
        SyncKind::None => return None,
        SyncKind::Full => vec![json!({ "text": full_text() })],
        SyncKind::Incremental => changes.iter().map(change_event).collect(),
    };
    Some(json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": content_changes }))
}

/// One change as a `TextDocumentContentChangeEvent` with a range.
pub fn change_event(change: &ContentChange) -> Value {
    json!({
        "range": {
            "start": { "line": change.start.line, "character": change.start.character },
            "end": { "line": change.end.line, "character": change.end.character },
        },
        "text": change.text,
    })
}

/// `textDocument/didSave`, with the text when the server asked for it.
pub fn did_save_params(uri: &str, text: Option<&str>) -> Value {
    match text {
        Some(text) => json!({ "textDocument": { "uri": uri }, "text": text }),
        None => json!({ "textDocument": { "uri": uri } }),
    }
}

/// `textDocument/didClose`.
pub fn did_close_params(uri: &str) -> Value {
    json!({ "textDocument": { "uri": uri } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Buffer, Command, EditorState};

    /// Applies what `did_change_params` carries to a copy of the text, the way a server would:
    /// in order, each range against the text so far, counting UTF-16 units.
    fn apply_like_a_server(mut text: String, params: &Value) -> String {
        for change in params["contentChanges"].as_array().unwrap() {
            let start = unit_to_byte(&text, &change["range"]["start"]);
            let end = unit_to_byte(&text, &change["range"]["end"]);
            text.replace_range(start..end, change["text"].as_str().unwrap());
        }
        text
    }

    fn unit_to_byte(text: &str, position: &Value) -> usize {
        let line = position["line"].as_u64().unwrap() as usize;
        let mut remaining = position["character"].as_u64().unwrap() as usize;
        let mut offset = 0;
        for (index, line_text) in text.split_inclusive('\n').enumerate() {
            if index < line {
                offset += line_text.len();
                continue;
            }
            for character in line_text.chars() {
                if remaining == 0 || character == '\n' {
                    break;
                }
                remaining = remaining.saturating_sub(character.len_utf16());
                offset += character.len_utf8();
            }
            return offset;
        }
        text.len()
    }

    fn type_text(state: &mut EditorState, text: &str) {
        state.apply(&Command::InsertText { text: text.into() });
    }

    #[test]
    fn what_the_buffer_records_keeps_a_servers_copy_in_step() {
        let original = "let a = \"😀\";\nlet größe = 1;\n";
        let mut state = EditorState::new(Buffer::from_text(original));
        state.take_content_changes();
        let mut server_copy = original.to_string();
        let mut version = 1;
        let mut step = |state: &mut EditorState, server_copy: &mut String| {
            let changes = state.take_content_changes();
            version += 1;
            let params = did_change_params("file:///a.ts", version, SyncKind::Incremental, &changes, String::new);
            *server_copy = apply_like_a_server(server_copy.clone(), &params.unwrap());
            let text = state.buffer().slice(0..state.buffer().length());
            assert_eq!(*server_copy, text);
        };
        state.apply(&Command::PlaceCursor { at: editor_core::Position { row: 0, column: 10 } });
        type_text(&mut state, "xyz");
        step(&mut state, &mut server_copy);
        state.apply(&Command::AddCursorBelow);
        type_text(&mut state, "É\n");
        step(&mut state, &mut server_copy);
        state.apply(&Command::SelectAll);
        state.apply(&Command::Cut);
        step(&mut state, &mut server_copy);
        state.apply(&Command::Undo);
        step(&mut state, &mut server_copy);
        state.apply(&Command::Paste { text: "one\ntwo".into() });
        step(&mut state, &mut server_copy);
    }

    #[test]
    fn servers_that_want_the_whole_text_get_it_and_others_hear_nothing() {
        let state = EditorState::new(Buffer::from_text("a"));
        let mut state = state;
        type_text(&mut state, "b");
        let changes = state.take_content_changes();
        let full = did_change_params("file:///a", 2, SyncKind::Full, &changes, || "whole".into()).unwrap();
        assert_eq!(full["contentChanges"], json!([{ "text": "whole" }]));
        assert!(did_change_params("file:///a", 2, SyncKind::None, &changes, String::new).is_none());
        assert!(did_change_params("file:///a", 2, SyncKind::Incremental, &[], String::new).is_none());
    }
}
