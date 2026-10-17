//! The open documents, shared between the editor views that show them and the commands the UI
//! calls. The text, selections and history live in `editor_core::Documents`; this wraps it in a
//! lock, since commands run on their own threads and views on the window's, and tells the UI what
//! happens to a document through events.
//!
//! Events, all on the app's `listen` channel:
//!
//! - `document-opened`: a document was created, with its summary.
//! - `document-closed`: `{ id }`.
//! - `document-dirty`: `{ id, dirty }`, when the unsaved-changes state flips.
//! - `document-saved`: `{ id }`.
//! - `document-error`: `{ id, message }`, such as a save that failed.
//! - `document-selections`: `{ id, count, row, column, selected }`, the newest cursor after any
//!   command that moved a selection.
//!
//! Commands: `document_open { path }`, `document_close { id }`, `document_list`,
//! `document_save { id }`.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use editor_core::{Command, Document, DocumentId, DocumentSummary, Documents, Outcome};
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

/// The documents behind a lock, and the way to tell the UI about them. Cheap to clone.
#[derive(Clone)]
pub struct SharedDocuments {
    documents: Arc<Mutex<Documents>>,
    emitter: Emitter,
}

impl SharedDocuments {
    /// An empty store whose events go out through `emitter`.
    pub fn new(emitter: Emitter) -> Self {
        SharedDocuments { documents: Arc::new(Mutex::new(Documents::new())), emitter }
    }

    /// Locks the store, carrying on after a thread that held it panicked.
    pub fn lock(&self) -> MutexGuard<'_, Documents> {
        self.documents.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Opens a file, or finds the document that has it, and tells the UI when one was created.
    pub fn open(&self, path: &str) -> Result<DocumentSummary, CommandError> {
        let mut documents = self.lock();
        let opened = documents
            .open(Path::new(path))
            .map_err(|error| CommandError::with_code("OpenFailed", format!("could not open {path}: {error}")))?;
        let summary = documents.get(opened.id).map(|document| document.summary());
        let Some(summary) = summary else {
            return Err(CommandError::with_code("OpenFailed", format!("{path} closed as it opened")));
        };
        if opened.created {
            self.emitter.emit("document-opened", json!(summary));
        }
        Ok(summary)
    }

    /// Closes a document, throwing away its unsaved changes, and tells the UI.
    pub fn close(&self, id: DocumentId) -> bool {
        let closed = self.lock().close(id);
        if closed {
            self.emitter.emit("document-closed", json!({ "id": id }));
        }
        closed
    }

    /// Every open document, in the order they were opened.
    pub fn list(&self) -> Vec<DocumentSummary> {
        self.lock().summaries()
    }

    /// Applies a command to a document and tells the UI about its effects: a save, a failed
    /// save, a change of the unsaved state, and where the newest cursor is. None when the
    /// document is not open.
    pub fn apply(&self, id: DocumentId, command: &Command) -> Option<Outcome> {
        let mut documents = self.lock();
        let applied = documents.apply(id, command)?;
        if applied.outcome.saved {
            self.emitter.emit("document-saved", json!({ "id": id }));
        }
        if let Some(message) = &applied.outcome.error {
            self.emitter.emit("document-error", json!({ "id": id, "message": message }));
        }
        if let Some(dirty) = applied.modified_changed {
            self.emitter.emit("document-dirty", json!({ "id": id, "dirty": dirty }));
        }
        if applied.outcome.changed {
            let selections = documents.get(id).map(selections_event);
            self.emitter.emit("document-selections", selections.unwrap_or(Value::Null));
        }
        Some(applied.outcome)
    }

    /// Registers the commands the UI opens, closes, lists and saves documents with.
    pub fn register(&self, commands: Commands) -> Commands {
        let opener = self.clone();
        let closer = self.clone();
        let lister = self.clone();
        let saver = self.clone();
        commands
            .command("document_open", move |args| {
                let path = string_argument(&args, "path")?;
                opener.open(&path).map(|summary| json!(summary))
            })
            .command("document_close", move |args| {
                let id = id_argument(&args)?;
                Ok::<_, CommandError>(json!(closer.close(id)))
            })
            .command("document_list", move |_| Ok::<_, CommandError>(json!(lister.list())))
            .command("document_save", move |args| saver.save(id_argument(&args)?))
    }

    /// Saves a document through the same command Ctrl-S makes, and fails when the write does.
    fn save(&self, id: DocumentId) -> Result<Value, CommandError> {
        let Some(outcome) = self.apply(id, &Command::Save) else {
            return Err(no_document(id));
        };
        match outcome.error {
            Some(message) => Err(CommandError::with_code("SaveFailed", message)),
            None => Ok(json!({ "saved": outcome.saved })),
        }
    }
}

/// What `document-selections` carries: how many cursors a document has and where the newest is.
fn selections_event(document: &Document) -> Value {
    let selections = document.state.selections();
    let newest = selections.newest();
    json!({
        "id": document.id(),
        "count": selections.count(),
        "row": newest.head.row,
        "column": newest.head.column,
        "selected": !newest.is_empty(),
    })
}

/// A string argument of a command, or the error that names what is missing.
fn string_argument(args: &Value, name: &str) -> Result<String, CommandError> {
    match args.get(name).and_then(Value::as_str) {
        Some(text) => Ok(text.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", format!("this command takes a string {name}"))),
    }
}

/// The document id a command was given.
fn id_argument(args: &Value) -> Result<DocumentId, CommandError> {
    match args.get("id").and_then(Value::as_u64) {
        Some(id) => Ok(id),
        None => Err(CommandError::with_code("InvalidArguments", "this command takes a document id")),
    }
}

/// The error for a command that names a document that is not open.
fn no_document(id: DocumentId) -> CommandError {
    CommandError::with_code("NoDocument", format!("document {id} is not open"))
}
