//! Text edits and workspace edits: what rename, code actions and formatting answer with. They
//! are read into plain data here and turned into editor positions against the text they apply to.

use editor_core::{Buffer, RangeEdit, Utf16Point};
use serde_json::Value;

use crate::protocol::TextEdit;

/// The edits for one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEdits {
    pub uri: String,
    pub edits: Vec<TextEdit>,
}

/// Everything a workspace edit changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceEdit {
    pub files: Vec<FileEdits>,
    /// Operations the editor does not carry out (creating, renaming and deleting files), by name.
    pub skipped: Vec<String>,
}

impl WorkspaceEdit {
    /// How many edits there are in all.
    pub fn edit_count(&self) -> usize {
        self.files.iter().map(|file| file.edits.len()).sum()
    }
}

/// Reads a workspace edit, from either its `changes` or its `documentChanges`.
pub fn parse_workspace_edit(edit: &Value) -> WorkspaceEdit {
    let mut result = WorkspaceEdit::default();
    if let Some(changes) = edit["documentChanges"].as_array() {
        for change in changes {
            match change["kind"].as_str() {
                Some(kind) => result.skipped.push(format!("{kind} {}", change["uri"].as_str().unwrap_or_default())),
                None => add_edits(&mut result, change["textDocument"]["uri"].as_str(), &change["edits"]),
            }
        }
        return result;
    }
    if let Some(changes) = edit["changes"].as_object() {
        for (uri, edits) in changes {
            add_edits(&mut result, Some(uri), edits);
        }
    }
    result
}

/// Adds the edits of one file, joining them to the file's earlier ones.
fn add_edits(result: &mut WorkspaceEdit, uri: Option<&str>, edits: &Value) {
    let Some(uri) = uri else {
        return;
    };
    let parsed = parse_text_edits(edits);
    if parsed.is_empty() {
        return;
    }
    match result.files.iter_mut().find(|file| file.uri == uri) {
        Some(file) => file.edits.extend(parsed),
        None => result.files.push(FileEdits { uri: uri.to_string(), edits: parsed }),
    }
}

/// Reads a list of text edits. An annotated edit counts as the plain one it extends.
pub fn parse_text_edits(edits: &Value) -> Vec<TextEdit> {
    let Some(list) = edits.as_array() else {
        return Vec::new();
    };
    list.iter().filter_map(|edit| serde_json::from_value(edit.clone()).ok()).collect()
}

/// The edits as replacements in the editor's positions, for a command to apply. Edits that the
/// server gave in any order go in order of their place; ones that were given at one place keep
/// the order they came in.
pub fn range_edits(buffer: &Buffer, edits: &[TextEdit]) -> Vec<RangeEdit> {
    let position = |line, character| buffer.position_of(buffer.offset_of_utf16_point(Utf16Point { line, character }));
    let mut converted: Vec<RangeEdit> = edits
        .iter()
        .map(|edit| RangeEdit {
            start: position(edit.range.start.line, edit.range.start.character),
            end: position(edit.range.end.line, edit.range.end.character),
            text: edit.new_text.clone(),
        })
        .collect();
    converted.sort_by_key(|edit| (edit.start, edit.end));
    converted
}

/// What `prepareRename` answers: where the symbol is and the name it has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameTarget {
    pub range: Option<crate::protocol::Range>,
    pub placeholder: Option<String>,
}

/// Reads the answer to `prepareRename`. None when the server says the place cannot be renamed.
pub fn parse_prepare_rename(result: &Value) -> Option<RenameTarget> {
    if result.is_null() {
        return None;
    }
    if result["defaultBehavior"].as_bool() == Some(true) {
        return Some(RenameTarget { range: None, placeholder: None });
    }
    if result.get("start").is_some() {
        let range = serde_json::from_value(result.clone()).ok()?;
        return Some(RenameTarget { range: Some(range), placeholder: None });
    }
    let range = serde_json::from_value(result["range"].clone()).ok()?;
    Some(RenameTarget { range: Some(range), placeholder: result["placeholder"].as_str().map(str::to_string) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::Position;
    use serde_json::json;

    fn edit(line: usize, from: usize, to: usize, text: &str) -> Value {
        json!({ "range": { "start": { "line": line, "character": from }, "end": { "line": line, "character": to } }, "newText": text })
    }

    #[test]
    fn changes_and_document_changes_are_both_read_and_files_are_joined() {
        let by_uri = parse_workspace_edit(&json!({ "changes": { "file:///a.ts": [edit(0, 0, 1, "x")] } }));
        assert_eq!(by_uri.files.len(), 1);
        let documents = parse_workspace_edit(&json!({
            "documentChanges": [
                { "textDocument": { "uri": "file:///a.ts", "version": 1 }, "edits": [edit(0, 0, 1, "x")] },
                { "textDocument": { "uri": "file:///b.ts", "version": null }, "edits": [edit(2, 0, 1, "y")] },
                { "textDocument": { "uri": "file:///a.ts", "version": 1 }, "edits": [edit(3, 0, 1, "z")] },
                { "kind": "rename", "oldUri": "file:///a.ts", "newUri": "file:///c.ts" },
            ]
        }));
        assert_eq!(documents.files.len(), 2);
        assert_eq!(documents.files[0].edits.len(), 2);
        assert_eq!(documents.edit_count(), 3);
        assert_eq!(documents.skipped.len(), 1);
    }

    #[test]
    fn edits_are_placed_in_the_editor_by_utf16_columns_and_sorted() {
        let buffer = Buffer::from_text("a😀b = 1\nsecond\n");
        let edits = parse_text_edits(&json!([edit(1, 0, 6, "line"), edit(0, 3, 4, "name")]));
        let converted = range_edits(&buffer, &edits);
        assert_eq!(converted[0].start, Position { row: 0, column: 2 });
        assert_eq!(converted[0].end, Position { row: 0, column: 3 });
        assert_eq!(converted[1].start, Position { row: 1, column: 0 });
    }

    #[test]
    fn prepare_rename_comes_in_three_shapes_and_a_refusal() {
        let range = json!({ "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } });
        assert_eq!(parse_prepare_rename(&range).unwrap().range.unwrap().start.character, 2);
        let named = parse_prepare_rename(&json!({ "range": range, "placeholder": "old" })).unwrap();
        assert_eq!(named.placeholder.as_deref(), Some("old"));
        assert_eq!(parse_prepare_rename(&json!({ "defaultBehavior": true })).unwrap().range, None);
        assert!(parse_prepare_rename(&Value::Null).is_none());
    }
}
