//! Carrying out the edits a server asks for: the ones for files that are open go through the
//! documents, so they can be undone and the other servers hear of them; the others are written
//! to their files.

use std::path::Path;
use std::time::Instant;

use editor_core::{Buffer, Command, EditorState};
use lsp_client::edits::{FileEdits, WorkspaceEdit, range_edits};
use lsp_client::glob::FileChange;
use lsp_client::uri::path_from_uri;

use super::LspStore;

/// What applying a workspace edit did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// How many files were changed, and how many of those were open.
    pub files: usize,
    pub open_files: usize,
    pub edits: usize,
    /// Why some of the edit could not be carried out.
    pub problems: Vec<String>,
}

impl Applied {
    /// A sentence for the status bar.
    pub fn summary(&self) -> String {
        let files = if self.files == 1 { "1 file".to_string() } else { format!("{} files", self.files) };
        let edits = if self.edits == 1 { "1 change".to_string() } else { format!("{} changes", self.edits) };
        let mut sentence = format!("{edits} in {files}");
        if let Some(problem) = self.problems.first() {
            sentence.push_str(&format!(", but {problem}"));
        }
        sentence
    }
}

impl LspStore {
    /// Applies a workspace edit to the open documents and the files that are not open.
    pub fn apply_workspace_edit(&self, edit: &WorkspaceEdit) -> Applied {
        let mut applied = Applied::default();
        let mut written = Vec::new();
        for skipped in &edit.skipped {
            applied.problems.push(format!("the editor does not do `{skipped}` yet"));
        }
        for file in &edit.files {
            let Some(path) = path_from_uri(&file.uri) else {
                applied.problems.push(format!("{} is not a file", file.uri));
                continue;
            };
            match self.apply_to_file(&path, file) {
                Ok(open) => {
                    applied.files += 1;
                    applied.edits += file.edits.len();
                    if open {
                        applied.open_files += 1;
                    } else {
                        written.push((path, FileChange::Changed));
                    }
                }
                Err(problem) => applied.problems.push(problem),
            }
        }
        self.files_changed(&written);
        applied
    }

    /// Applies the edits of one file. Returns whether the file was open.
    fn apply_to_file(&self, path: &Path, file: &FileEdits) -> Result<bool, String> {
        let open = self.inner().documents().lock().find_by_path(path);
        if let Some(id) = open {
            return self.apply_to_document(id, file).map(|_| true);
        }
        let buffer = Buffer::open(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
        let mut state = EditorState::new(buffer);
        let edits = range_edits(state.buffer(), &file.edits);
        state.apply_at(&Command::ApplyEdits { edits }, Instant::now());
        state.buffer().save().map_err(|error| format!("could not write {}: {error}", path.display()))?;
        Ok(false)
    }

    /// Applies the edits of one file to its open document.
    fn apply_to_document(&self, id: editor_core::DocumentId, file: &FileEdits) -> Result<(), String> {
        let documents = self.inner().documents();
        let edits = match documents.lock().get(id) {
            Some(document) => range_edits(document.state.buffer(), &file.edits),
            None => return Err(format!("{} was closed", file.uri)),
        };
        documents.apply(id, &Command::ApplyEdits { edits });
        self.inner().signals().redraw(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::{SharedDocuments, Signals};
    use lsp_client::edits::parse_workspace_edit;
    use serde_json::json;
    use svelte_gpui::Emitter;

    fn edit_json(uri: &str, line: usize, from: usize, to: usize, text: &str) -> serde_json::Value {
        json!({ "textDocument": { "uri": uri, "version": null }, "edits": [{
            "range": { "start": { "line": line, "character": from }, "end": { "line": line, "character": to } },
            "newText": text }] })
    }

    #[test]
    fn open_files_are_edited_through_their_documents_and_the_rest_are_written() {
        let directory = std::env::temp_dir().join(format!("grove-lsp-apply-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let (open_path, closed_path) = (directory.join("open.txt"), directory.join("closed.txt"));
        std::fs::write(&open_path, "alpha beta\n").unwrap();
        std::fs::write(&closed_path, "one\nalpha\n").unwrap();
        let documents = SharedDocuments::new(Emitter::default());
        let store = LspStore::with_search_directories(documents.clone(), Emitter::default(), Signals::default(), vec![]);
        let id = documents.open(&open_path.display().to_string()).unwrap().id;

        let uri = |path: &Path| lsp_client::uri::uri_from_path(path);
        let edit = parse_workspace_edit(&json!({ "documentChanges": [
            edit_json(&uri(&open_path), 0, 0, 5, "omega"),
            edit_json(&uri(&closed_path), 1, 0, 5, "omega"),
            edit_json("untitled:Untitled-1", 0, 0, 1, "x"),
        ] }));
        let applied = store.apply_workspace_edit(&edit);
        assert_eq!((applied.files, applied.open_files, applied.edits), (2, 1, 2));
        assert_eq!(applied.problems.len(), 1);
        assert!(applied.summary().starts_with("2 changes in 2 files"));

        assert_eq!(documents.text(id).unwrap(), "omega beta\n");
        assert!(documents.list()[0].dirty, "an open file is left unsaved so it can be undone");
        assert_eq!(std::fs::read_to_string(&open_path).unwrap(), "alpha beta\n");
        assert_eq!(std::fs::read_to_string(&closed_path).unwrap(), "one\nomega\n");
        documents.apply(id, &Command::Undo).unwrap();
        assert_eq!(documents.text(id).unwrap(), "alpha beta\n");
    }
}
