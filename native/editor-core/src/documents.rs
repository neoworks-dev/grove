//! The documents that are open: each an `EditorState` kept under an id, so any number of views
//! can show the same text, selections and history, and a view that goes away and comes back
//! loses nothing. Views, tabs and panes refer to a document by its id and never hold its text.
//!
//! Selections and the scroll position belong to the document, so two views of one document show
//! the same cursors. Per-view selections would be a change here, in `Document`, and nowhere else.

use std::io;
use std::path::Path;

use serde::Serialize;

use crate::buffer::Buffer;
use crate::command::{Command, Outcome};
use crate::decorations::Decoration;
use crate::indent::IndentStyle;
use crate::state::EditorState;
use crate::vim::registers::VimMemory;

/// Names a document for as long as it stays open. Ids are never reused.
pub type DocumentId = u64;

/// One open file: its editing state, and where it was last scrolled to.
pub struct Document {
    id: DocumentId,
    pub state: EditorState,
    /// Pixels from the top of the first line, kept here so a view that is made again starts
    /// where the last one stopped.
    pub scroll_top: f32,
    /// The modified state the app was last told about, so it hears of changes only.
    reported_modified: bool,
    /// Text that is shown but belongs to no file, such as one side of a diff. Its buffer is named
    /// like a file so it is highlighted as one, but it is never found by path or written.
    detached: bool,
}

impl Document {
    /// The id the document is known by.
    pub fn id(&self) -> DocumentId {
        self.id
    }

    /// The file behind the document, if any.
    pub fn path(&self) -> Option<&Path> {
        self.state.buffer().path()
    }

    /// The file's name, which is what a tab shows.
    pub fn title(&self) -> String {
        let Some(path) = self.path() else {
            return "Untitled".to_string();
        };
        match path.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => path.display().to_string(),
        }
    }

    /// Whether the document is text that belongs to no file.
    pub fn is_detached(&self) -> bool {
        self.detached
    }

    /// What the app is told about the document.
    pub fn summary(&self) -> DocumentSummary {
        let mut path = self.path().map(|path| path.display().to_string());
        if self.detached {
            path = None;
        }
        DocumentSummary {
            id: self.id,
            path,
            title: self.title(),
            dirty: self.state.is_modified(),
            indent: self.state.buffer().indent(),
        }
    }
}

/// A document as the app sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DocumentSummary {
    pub id: DocumentId,
    pub path: Option<String>,
    pub title: String,
    pub dirty: bool,
    /// How the file is indented, for the status bar.
    pub indent: IndentStyle,
}

/// What applying a command to a document did.
#[derive(Debug)]
pub struct Applied {
    pub outcome: Outcome,
    /// The new modified state when the command changed it, so the app hears of changes only.
    pub modified_changed: Option<bool>,
}

/// The result of opening a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opened {
    pub id: DocumentId,
    /// False when the path was already open and its document was handed back as it is.
    pub created: bool,
}

/// Every open document, in the order they were opened.
#[derive(Default)]
pub struct Documents {
    next_id: DocumentId,
    documents: Vec<Document>,
    /// Vim's registers and last search, which every document shares: a command works on the
    /// document's own copy of them for as long as it runs, then they are handed back.
    memory: VimMemory,
    /// The indentation style of files whose own lines do not say.
    default_indent: IndentStyle,
}

impl Documents {
    /// No documents.
    pub fn new() -> Self {
        Documents::default()
    }

    /// Opens a file, or hands back the document that already has it, edits and all. Two ways of
    /// naming one file, such as a symlink and its target, are the same document.
    pub fn open(&mut self, path: &Path) -> io::Result<Opened> {
        let canonical = path.canonicalize()?;
        if let Some(existing) = self.find_by_path(&canonical) {
            return Ok(Opened { id: existing, created: false });
        }
        let buffer = Buffer::open(&canonical)?;
        Ok(Opened { id: self.insert(EditorState::new(buffer)), created: true })
    }

    /// Adds a document for text that has no file yet.
    pub fn open_untitled(&mut self, text: &str) -> DocumentId {
        self.insert(EditorState::new(Buffer::from_text(text)))
    }

    /// Adds a document for text that belongs to no file. `name` only says what language the
    /// text is, by its extension, and what the tab is called. Saving it fails.
    pub fn open_detached(&mut self, text: &str, name: &Path) -> DocumentId {
        let id = self.insert(EditorState::new(Buffer::from_text_named(text, name)));
        if let Some(document) = self.get_mut(id) {
            document.detached = true;
        }
        id
    }

    /// Replaces all the text of a document that belongs to no file, with one cursor at its
    /// start. Says whether the document is one of those.
    pub fn replace_detached_text(&mut self, id: DocumentId, text: &str) -> bool {
        let Some(document) = self.get_mut(id) else {
            return false;
        };
        if !document.detached {
            return false;
        }
        let name = document.path().map(Path::to_path_buf).unwrap_or_default();
        document.state.replace_buffer(Buffer::from_text_named(text, &name));
        document.reported_modified = false;
        true
    }

    /// Reads a document's file again, dropping its edits and history. Fails for a document
    /// that has no file, or whose file cannot be read.
    pub fn reload(&mut self, id: DocumentId) -> io::Result<()> {
        let Some(document) = self.get_mut(id) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "this document is not open"));
        };
        let Some(path) = document.path().filter(|_| !document.detached).map(Path::to_path_buf) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "this document has no file"));
        };
        document.state.replace_buffer(Buffer::open(&path)?);
        document.reported_modified = false;
        Ok(())
    }

    /// Brings a document up to date with its file after another program changed it, keeping
    /// its cursors and history. A document with unsaved changes is left alone, so they are not
    /// lost. Says whether the text changed.
    pub fn sync_with_disk(&mut self, id: DocumentId) -> io::Result<bool> {
        let Some(document) = self.get_mut(id) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "this document is not open"));
        };
        let Some(path) = document.path().filter(|_| !document.detached).map(Path::to_path_buf) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "this document has no file"));
        };
        if document.state.is_modified() {
            return Ok(false);
        }
        let text = std::fs::read_to_string(&path)?;
        Ok(document.state.take_disk_text(&text))
    }

    /// The id of the document that has a file open, if there is one.
    pub fn find_by_path(&self, path: &Path) -> Option<DocumentId> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let has_file = |document: &&Document| !document.detached && document.path() == Some(canonical.as_path());
        self.documents.iter().find(has_file).map(Document::id)
    }

    /// A document, if it is open.
    pub fn get(&self, id: DocumentId) -> Option<&Document> {
        self.documents.iter().find(|document| document.id == id)
    }

    /// A document to change, if it is open.
    pub fn get_mut(&mut self, id: DocumentId) -> Option<&mut Document> {
        self.documents.iter_mut().find(|document| document.id == id)
    }

    /// Closes a document, throwing away unsaved changes. Says whether it was open.
    pub fn close(&mut self, id: DocumentId) -> bool {
        let before = self.documents.len();
        self.documents.retain(|document| document.id != id);
        self.documents.len() != before
    }

    /// Every open document, in the order they were opened.
    pub fn summaries(&self) -> Vec<DocumentSummary> {
        self.documents.iter().map(Document::summary).collect()
    }

    /// Applies a command to a document, and says what it did along with whether the modified
    /// state changed since the app last heard of it. None when the document is not open.
    pub fn apply(&mut self, id: DocumentId, command: &Command) -> Option<Applied> {
        if command == &Command::Save && self.get(id).is_some_and(Document::is_detached) {
            let outcome = Outcome {
                error: Some("this text belongs to no file, so there is nothing to save".into()),
                ..Outcome::default()
            };
            return Some(Applied { outcome, modified_changed: None });
        }
        let uses_memory = command.is_vim();
        let mut memory = std::mem::take(&mut self.memory);
        let document = self.get_mut(id);
        let Some(document) = document else {
            self.memory = memory;
            return None;
        };
        if uses_memory {
            std::mem::swap(&mut document.state.memory, &mut memory);
        }
        let outcome = document.state.apply(command);
        if uses_memory {
            std::mem::swap(&mut document.state.memory, &mut memory);
        }
        let modified = document.state.is_modified();
        let mut modified_changed = None;
        if modified != document.reported_modified {
            document.reported_modified = modified;
            modified_changed = Some(modified);
        }
        self.memory = memory;
        Some(Applied { outcome, modified_changed })
    }

    /// The marks for the matches of vim's last search in some rows of a document, none when the
    /// highlight is off or the document is not open.
    pub fn search_highlights(&self, id: DocumentId, rows: std::ops::Range<usize>) -> Vec<Decoration> {
        let Some(document) = self.get(id) else {
            return Vec::new();
        };
        crate::vim::hlsearch::search_decorations(document.state.buffer(), &self.memory, rows)
    }

    /// Sets the indentation style of files whose own lines do not say, for the documents that are
    /// open and the ones opened later. Returns the documents it changed.
    pub fn set_default_indent(&mut self, style: IndentStyle) -> Vec<DocumentId> {
        self.default_indent = style;
        let mut changed = Vec::new();
        for document in &mut self.documents {
            if document.state.apply_default_indent(style) {
                changed.push(document.id);
            }
        }
        changed
    }

    /// Has every document pick its language again, for grammars that arrived after it was opened.
    /// Returns the documents whose highlighting changed.
    pub fn refresh_syntax(&mut self) -> Vec<DocumentId> {
        let mut changed = Vec::new();
        for document in &mut self.documents {
            if document.state.refresh_syntax() {
                changed.push(document.id);
            }
        }
        changed
    }

    /// Adds a document over a state and gives it the next id.
    fn insert(&mut self, mut state: EditorState) -> DocumentId {
        state.apply_default_indent(self.default_indent);
        self.next_id += 1;
        let id = self.next_id;
        self.documents.push(Document { id, state, scroll_top: 0.0, reported_modified: false, detached: false });
        id
    }
}
