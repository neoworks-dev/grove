//! Formatting a document: `prettierd` when the project has a Prettier config, and the language
//! server's own formatter otherwise. Edits are kept as small as whole lines allow and go in as
//! one step for undo, so cursors stay where they were and one undo takes the format back.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use editor_core::{Buffer, Command, DocumentId, RangeEdit};
use lsp_client::edits::{parse_text_edits, range_edits};
use lsp_client::registry;
use lsp_client::tools;
use serde_json::json;
use svelte_gpui_editor::Formatted;

use super::LspStore;

/// How long saving waits for a formatter before it saves the file as it is.
pub const FORMAT_ON_SAVE_LIMIT: Duration = Duration::from_millis(1500);

/// A document's text as the formatters see it.
struct Snapshot {
    path: PathBuf,
    text: String,
}

impl LspStore {
    /// Formats a document, waiting up to `limit` for the formatter. Returns none when nothing can
    /// format this kind of file, and an error that names what went wrong otherwise.
    pub fn format(&self, document: DocumentId, limit: Duration) -> Result<Option<Formatted>, String> {
        let snapshot = self.snapshot(document).ok_or("the document is not open")?;
        let edits = match self.format_with_prettierd(&snapshot)? {
            Some(edits) => ("prettierd", edits),
            None => match self.format_with_server(document, &snapshot, limit)? {
                Some(edits) => ("the language server", edits),
                None => return Ok(None),
            },
        };
        let (formatter, edits) = edits;
        let changed = !edits.is_empty();
        if changed {
            self.apply_formatting(document, &snapshot, edits)?;
        }
        Ok(Some(Formatted { formatter, changed }))
    }

    /// Whether anything is able to format the document, which decides if saving waits for it.
    pub fn can_format(&self, document: DocumentId) -> bool {
        let Some(snapshot) = self.snapshot(document) else {
            return false;
        };
        if tools::prettier_root(&snapshot.path).is_some() && self.prettierd().is_some() {
            return true;
        }
        self.capabilities(document).is_some_and(|capabilities| capabilities.formatting)
    }

    /// The path and text of a document that has a file.
    fn snapshot(&self, document: DocumentId) -> Option<Snapshot> {
        let documents = self.inner().documents().lock();
        let state = &documents.get(document)?.state;
        let path = state.buffer().path()?.to_path_buf();
        Some(Snapshot { path, text: state.buffer().slice(0..state.buffer().length()) })
    }

    /// Where `prettierd` is installed, if it is.
    fn prettierd(&self) -> Option<PathBuf> {
        registry::find_executable("prettierd", self.search_directories())
    }

    /// The edits `prettierd` makes, or none when the project does not use Prettier here.
    fn format_with_prettierd(&self, snapshot: &Snapshot) -> Result<Option<Vec<RangeEdit>>, String> {
        let Some(root) = tools::prettier_root(&snapshot.path) else {
            return Ok(None);
        };
        let Some(program) = self.prettierd() else {
            return Ok(None);
        };
        let formatted = tools::format_with_prettierd(&program, &snapshot.path, &snapshot.text, &root)?;
        Ok(Some(tools::line_edits(&snapshot.text, &formatted)))
    }

    /// The edits the language server's formatter makes, or none when it has no formatter.
    fn format_with_server(
        &self,
        document: DocumentId,
        snapshot: &Snapshot,
        limit: Duration,
    ) -> Result<Option<Vec<RangeEdit>>, String> {
        let Some(capabilities) = self.capabilities(document) else {
            return Ok(None);
        };
        let Some(uri) = self.uri_of(document) else {
            return Ok(None);
        };
        if !capabilities.formatting {
            return Ok(None);
        }
        let options = formatting_options(&self.inner().documents().lock(), document);
        let params = json!({ "textDocument": { "uri": uri }, "options": options });
        let (sender, receiver) = mpsc::channel();
        let reply = Box::new(move |result| {
            let _ = sender.send(result);
        });
        self.request_for(document, "textDocument/formatting", params, reply).ok_or("the server went away")?;
        let answer = receiver.recv_timeout(limit).map_err(|_| "the language server took too long to format")?;
        let answer = answer.map_err(|error| error.message)?;
        let buffer = Buffer::from_text(&snapshot.text);
        Ok(Some(range_edits(&buffer, &parse_text_edits(&answer))))
    }

    /// Puts the formatting in, unless the text changed while the formatter worked.
    fn apply_formatting(&self, document: DocumentId, snapshot: &Snapshot, edits: Vec<RangeEdit>) -> Result<(), String> {
        let current = self.snapshot(document).ok_or("the document was closed while it was formatted")?;
        if current.text != snapshot.text {
            return Err("the file changed while it was formatted".to_string());
        }
        self.inner().documents().apply(document, &Command::ApplyEdits { edits });
        self.inner().signals().redraw(document);
        Ok(())
    }

    /// Formats a document that is about to be saved, if the person wants that. A formatter that
    /// fails leaves the file as it is and the reason in the status bar; the save goes ahead.
    pub(crate) fn format_before_saving(&self, document: DocumentId) {
        if !self.settings().format_on_save || !self.can_format(document) {
            return;
        }
        if let Err(problem) = self.format(document, FORMAT_ON_SAVE_LIMIT) {
            self.notice(&format!("Not formatted: {problem}"));
        }
    }

    /// Says something in the status bar.
    pub fn notice(&self, message: &str) {
        self.inner().documents().announce("editor-notice", json!({ "message": message }));
    }
}

/// The `options` of a formatting request: the document's own indentation.
fn formatting_options(documents: &editor_core::Documents, document: DocumentId) -> serde_json::Value {
    let indent = match documents.get(document) {
        Some(document) => document.state.buffer().indent(),
        None => editor_core::IndentStyle::Spaces { width: 4 },
    };
    match indent {
        editor_core::IndentStyle::Tabs => json!({ "tabSize": 4, "insertSpaces": false }),
        editor_core::IndentStyle::Spaces { width } => json!({ "tabSize": width, "insertSpaces": true }),
    }
}
