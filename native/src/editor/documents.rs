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
//! `document_save { id }`, and `document_set_decorations { id, source, decorations }`, which
//! replaces what one source has put on top of the text (see `editor_core::decorations` for the
//! shape of a decoration; an empty list removes the source). The views have to be asked to
//! redraw afterwards, which is the `refresh` method of the editor element.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use editor_core::{
    Command, ContentChange, Decoration, Document, DocumentId, DocumentSummary, Documents, EditorState, Outcome,
};
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

/// Hears what happens to documents, to keep something else in step with them, such as a language
/// server. Called while the documents are locked, so a call is made in the order things happened
/// and must not lock the documents itself or wait for anything.
pub trait DocumentObserver: Send + Sync {
    /// A document was created for a file.
    fn opened(&self, id: DocumentId, state: &EditorState);
    /// The text of a document changed.
    fn changed(&self, id: DocumentId, state: &EditorState, changes: Vec<ContentChange>);
    /// A document was written to its file.
    fn saved(&self, id: DocumentId, state: &EditorState);
    /// A document was closed.
    fn closed(&self, id: DocumentId);
}

/// The documents behind a lock, and the way to tell the UI about them. Cheap to clone.
#[derive(Clone)]
pub struct SharedDocuments {
    documents: Arc<Mutex<Documents>>,
    emitter: Emitter,
    observer: Arc<OnceLock<Arc<dyn DocumentObserver>>>,
}

impl SharedDocuments {
    /// An empty store whose events go out through `emitter`.
    pub fn new(emitter: Emitter) -> Self {
        SharedDocuments {
            documents: Arc::new(Mutex::new(Documents::new())),
            emitter,
            observer: Arc::new(OnceLock::new()),
        }
    }

    /// Lets something hear what happens to documents from now on. Only the first observer is kept.
    pub fn observe(&self, observer: Arc<dyn DocumentObserver>) {
        let _ = self.observer.set(observer);
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
            if let (Some(observer), Some(document)) = (self.observer.get(), documents.get(opened.id)) {
                observer.opened(opened.id, &document.state);
            }
            self.emitter.emit("document-opened", json!(summary));
        }
        Ok(summary)
    }

    /// Closes a document, throwing away its unsaved changes, and tells the UI.
    pub fn close(&self, id: DocumentId) -> bool {
        let mut documents = self.lock();
        let closed = documents.close(id);
        if closed {
            if let Some(observer) = self.observer.get() {
                observer.closed(id);
            }
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
        self.tell_observer(&mut documents, id, &applied.outcome);
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

    /// Tells the observer what a command did to a document's text, and whether it saved it.
    fn tell_observer(&self, documents: &mut Documents, id: DocumentId, outcome: &Outcome) {
        let Some(document) = documents.get_mut(id) else {
            return;
        };
        // Taken even when nobody listens, so the buffer's record of changes never piles up.
        let changes = document.state.take_content_changes();
        let Some(observer) = self.observer.get() else {
            return;
        };
        if !changes.is_empty() {
            observer.changed(id, &document.state, changes);
        }
        if outcome.saved {
            observer.saved(id, &document.state);
        }
    }

    /// Registers the commands the UI opens, closes, lists and saves documents with.
    pub fn register(&self, commands: Commands) -> Commands {
        let opener = self.clone();
        let closer = self.clone();
        let lister = self.clone();
        let saver = self.clone();
        let decorator = self.clone();
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
            .command("document_set_decorations", move |args| decorator.set_decorations(&args))
    }

    /// Replaces the decorations one source has on a document, from the arguments of
    /// `document_set_decorations`.
    fn set_decorations(&self, args: &Value) -> Result<Value, CommandError> {
        let id = id_argument(args)?;
        let source = string_argument(args, "source")?;
        let decorations: Vec<Decoration> = match args.get("decorations") {
            Some(list) => serde_json::from_value(list.clone())
                .map_err(|error| CommandError::with_code("InvalidArguments", format!("bad decorations: {error}")))?,
            None => Vec::new(),
        };
        match self.apply(id, &Command::SetDecorations { source, decorations }) {
            Some(_) => Ok(Value::Null),
            None => Err(no_document(id)),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A file in a directory of its own, so tests do not share files.
    fn file_with(name: &str, text: &str) -> String {
        let directory = std::env::temp_dir().join(format!("grove-native-documents-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        std::fs::write(&path, text).unwrap();
        path.display().to_string()
    }

    #[test]
    fn opening_twice_gives_the_same_document() {
        let documents = SharedDocuments::new(Emitter::default());
        let path = file_with("twice.rs", "one\n");
        let first = documents.open(&path).unwrap();
        let second = documents.open(&path).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(documents.list().len(), 1);
    }

    #[test]
    fn a_missing_file_is_an_open_failure() {
        let documents = SharedDocuments::new(Emitter::default());
        let error = documents.open("/no/such/file.rs").unwrap_err();
        assert_eq!(error.code.as_deref(), Some("OpenFailed"));
    }

    #[test]
    fn edits_survive_closing_and_reopening_the_view_but_not_the_document() {
        let documents = SharedDocuments::new(Emitter::default());
        let path = file_with("edits.rs", "one\n");
        let id = documents.open(&path).unwrap().id;
        documents.apply(id, &Command::InsertText { text: "X".into() }).unwrap();
        assert!(documents.list()[0].dirty);
        assert_eq!(documents.open(&path).unwrap().id, id);
        assert!(documents.list()[0].dirty);
        assert!(documents.close(id));
        assert!(!documents.open(&path).unwrap().dirty);
    }

    #[test]
    fn saving_through_the_command_clears_the_dirty_state() {
        let documents = SharedDocuments::new(Emitter::default());
        let path = file_with("save.rs", "one\n");
        let id = documents.open(&path).unwrap().id;
        documents.apply(id, &Command::InsertText { text: "X".into() }).unwrap();
        documents.save(id).unwrap();
        assert!(!documents.list()[0].dirty);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Xone\n");
    }

    #[test]
    fn a_source_sets_decorations_on_a_document_by_id() {
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&file_with("decorated.rs", "one\ntwo\n")).unwrap().id;
        let line_end = json!({ "start": { "row": 1, "column": 0 }, "kind": "line_end", "text": "blame" });
        documents.set_decorations(&json!({ "id": id, "source": "git.blame", "decorations": [line_end] })).unwrap();
        assert_eq!(documents.lock().get(id).unwrap().state.decoration_count("git.blame"), 1);
        documents.set_decorations(&json!({ "id": id, "source": "git.blame", "decorations": [] })).unwrap();
        assert_eq!(documents.lock().get(id).unwrap().state.decoration_count("git.blame"), 0);
    }

    #[test]
    fn bad_decorations_and_unknown_documents_are_errors() {
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&file_with("bad.rs", "one\n")).unwrap().id;
        let bad = json!({ "id": id, "source": "x", "decorations": [{ "kind": "nonsense" }] });
        assert_eq!(documents.set_decorations(&bad).unwrap_err().code.as_deref(), Some("InvalidArguments"));
        let missing = json!({ "id": 99, "source": "x", "decorations": [] });
        assert_eq!(documents.set_decorations(&missing).unwrap_err().code.as_deref(), Some("NoDocument"));
    }

    #[test]
    fn saving_a_closed_document_is_an_error() {
        let documents = SharedDocuments::new(Emitter::default());
        assert_eq!(documents.save(9).unwrap_err().code.as_deref(), Some("NoDocument"));
    }
}
