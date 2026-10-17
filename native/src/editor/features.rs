//! The state of the language features around the cursor that go beyond completion and hover:
//! signature help, the lists of references and code actions, the rename box, inlay hints and the
//! server's highlights. Each lives in its own file; this one holds what they share, and the
//! answers they wait for, which arrive as `FeatureSignal`s on the window's thread.

use std::path::PathBuf;

use editor_core::{DocumentId, Position};
use lsp_client::actions::CodeAction;
use lsp_client::edits::RenameTarget;
use lsp_client::inlay::Hint;
use lsp_client::protocol::Range;
use lsp_client::signature::SignatureHelp;
use serde_json::Value;
use svelte_gpui::gpui::Context;

use super::Editor;
use super::menu::{LocationItem, Menu};
use super::rename::RenameBox;
use super::signature::SignatureSession;
use crate::lsp::{Applied, Pending};

/// What the answers to those requests are told to the view as.
pub enum FeatureSignal {
    /// The signatures at the cursor, with the answer as the server gave it, or none.
    Signature { request: u64, help: Option<(SignatureHelp, Value)> },
    /// The inlay hints for the rows asked about.
    Hints { request: u64, hints: Vec<Hint> },
    /// The other places the server says are the symbol at the cursor.
    Highlights { request: u64, ranges: Vec<Range> },
    /// The places that use a symbol, or where it is implemented.
    Locations { request: u64, items: Vec<LocationItem> },
    /// Whether the symbol at the cursor can be renamed, and what it is called.
    PrepareRename { request: u64, result: Result<Option<RenameTarget>, String> },
    /// How a rename went.
    Renamed { request: u64, result: Result<Applied, String> },
    /// The actions on offer at the cursor.
    Actions { request: u64, actions: Vec<CodeAction> },
}

/// What the features hold for one view.
#[derive(Default)]
pub struct Features {
    pub signature: Option<SignatureSession>,
    pub menu: Option<Menu>,
    pub rename: Option<RenameBox>,
    /// The request for hints that is out, and the rows the last one covered.
    pub hints_request: u64,
    pub hints_pending: Option<Pending>,
    pub hints_range: Option<(DocumentId, usize, usize)>,
    pub hints_timer_armed: bool,
    /// The request for the server's highlights that is out.
    pub highlight_request: u64,
    pub highlight_pending: Option<Pending>,
}

impl Editor {
    /// Reacts to the answer to a request around the cursor.
    pub(super) fn feature_signal(&mut self, signal: FeatureSignal, cx: &mut Context<Self>) {
        match signal {
            FeatureSignal::Signature { request, help } => self.signature_arrived(request, help, cx),
            FeatureSignal::Hints { request, hints } => self.hints_arrived(request, hints, cx),
            FeatureSignal::Highlights { request, ranges } => self.highlights_arrived(request, ranges, cx),
            FeatureSignal::Locations { request, items } => self.locations_arrived(request, items, cx),
            FeatureSignal::PrepareRename { request, result } => self.prepare_rename_arrived(request, result, cx),
            FeatureSignal::Renamed { request, result } => self.rename_finished(request, result, cx),
            FeatureSignal::Actions { request, actions } => self.actions_arrived(request, actions, cx),
        }
    }

    /// Says something in the status bar.
    pub(super) fn notice(&self, message: &str) {
        self.lsp.notice(message);
    }

    /// Lets go of everything the features hold, as the view shows another document.
    pub(super) fn reset_features(&mut self) {
        self.close_signature();
        self.close_menu();
        self.features.rename = None;
        self.features.hints_range = None;
        if let Some(pending) = self.features.hints_pending.take() {
            pending.cancel();
        }
        if let Some(pending) = self.features.highlight_pending.take() {
            pending.cancel();
        }
    }

    /// Formats the document on a thread of its own, and says in the status bar how it went.
    pub(super) fn format_now(&mut self) {
        let Some(document) = self.document else {
            return;
        };
        if self.read_only {
            return;
        }
        let store = self.lsp.clone();
        std::thread::spawn(move || {
            let message = match store.format(document, std::time::Duration::from_secs(10)) {
                Ok(Some(formatted)) if formatted.changed => format!("Formatted with {}", formatted.formatter),
                Ok(Some(formatted)) => format!("Already formatted ({})", formatted.formatter),
                Ok(None) => "No formatter available for this file".to_string(),
                Err(problem) => format!("Not formatted: {problem}"),
            };
            store.notice(&message);
        });
    }

    /// The path of the document the view shows.
    pub(super) fn own_path(&self) -> Option<PathBuf> {
        self.read(|state| state.buffer().path().map(|path| path.to_path_buf())).flatten()
    }

    /// The newest cursor's place.
    pub(super) fn cursor(&self) -> Option<Position> {
        self.read(|state| state.selections().newest().head)
    }

    /// Opens a place in a file: by moving the cursor when it is in the document shown, else by
    /// asking the app to open the file.
    pub(super) fn open_location(&mut self, path: PathBuf, line: usize, character: usize, cx: &mut Context<Self>) {
        if self.own_path().as_deref() == Some(path.as_path()) {
            self.go_to(line, character, cx);
            return;
        }
        let event = serde_json::json!({ "path": path.display().to_string(), "line": line, "character": character });
        self.host.emit("goto", event);
    }
}
