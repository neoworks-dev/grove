//! ESLint for JavaScript and TypeScript, through `eslint_d` rather than a language server: the
//! daemon starts once and answers in milliseconds, and it reads the project's own config. It
//! runs when a file opens or is saved and shortly after the person stops typing, and what it
//! finds is shown like the servers' diagnostics, under a source of its own (`lint.eslint`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use editor_core::DocumentId;
use lsp_client::diagnostics::decorations_for;
use lsp_client::registry;
use lsp_client::tools;

use super::LspStore;

/// The name the decoration set for ESLint's findings goes by.
pub const ESLINT_SOURCE: &str = "lint.eslint";

/// How long after the last keystroke the text is linted.
const LINT_AFTER_TYPING: Duration = Duration::from_millis(600);

/// Which run of the linter is the latest for each document, so a run that was overtaken is dropped.
#[derive(Default)]
pub struct LintRuns {
    latest: Mutex<HashMap<DocumentId, u64>>,
}

impl LintRuns {
    /// Starts a new run for a document, which makes every earlier one out of date.
    fn begin(&self, document: DocumentId) -> u64 {
        let mut latest = self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let run = latest.entry(document).or_insert(0);
        *run += 1;
        *run
    }

    /// Whether a run is still the latest.
    fn is_latest(&self, document: DocumentId, run: u64) -> bool {
        let latest = self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        latest.get(&document) == Some(&run)
    }

    /// Forgets a document.
    pub fn forget(&self, document: DocumentId) {
        self.latest.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&document);
    }
}

impl LspStore {
    /// Lints a document after `delay`, unless it changes again first. Does nothing when ESLint
    /// is switched off, the file is not one it lints, or the project has no config.
    pub fn lint_soon(&self, document: DocumentId, delay: Duration) {
        if !self.settings().eslint || self.is_disabled() {
            return;
        }
        let run = self.inner().lint_runs.begin(document);
        let store = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            store.lint(document, run);
        });
    }

    /// Lints a document after the person has stopped typing.
    pub(crate) fn lint_after_typing(&self, document: DocumentId) {
        self.lint_soon(document, LINT_AFTER_TYPING);
    }

    /// Takes ESLint's findings off a document and stops what is running for it.
    pub fn clear_lint(&self, document: DocumentId) {
        self.inner().lint_runs.begin(document);
        let cleared = match self.inner().documents().lock().get_mut(document) {
            Some(doc) => {
                doc.state.set_decorations(ESLINT_SOURCE, &[]);
                true
            }
            None => false,
        };
        if cleared {
            self.inner().signals().redraw(document);
        }
    }

    /// Lints or clears every open document, as the ESLint switch changes.
    pub(crate) fn lint_all(&self) {
        let documents: Vec<DocumentId> = self.state().tracked.keys().copied().collect();
        for document in documents {
            if self.settings().eslint {
                self.lint_soon(document, Duration::ZERO);
            } else {
                self.clear_lint(document);
            }
        }
    }

    /// Runs `eslint_d` on the text a document has now and shows what it finds, unless a newer
    /// run has started or the text changed meanwhile.
    fn lint(&self, document: DocumentId, run: u64) {
        if !self.inner().lint_runs.is_latest(document, run) {
            return;
        }
        let Some((path, text, version)) = self.lint_input(document) else {
            return;
        };
        let Some(root) = tools::eslint_root(&path) else {
            return;
        };
        let Some(program) = registry::find_executable("eslint_d", self.search_directories()) else {
            return;
        };
        let found = tools::lint_with_eslint_d(&program, &path, &text, &root);
        if !self.inner().lint_runs.is_latest(document, run) || self.version_of(document) != Some(version) {
            return;
        }
        let diagnostics = match found {
            Ok(diagnostics) => diagnostics,
            Err(problem) => {
                eprintln!("[lint] eslint_d: {problem}");
                return;
            }
        };
        let applied = match self.inner().documents().lock().get_mut(document) {
            Some(doc) => {
                let decorations = decorations_for(doc.state.buffer(), &diagnostics);
                doc.state.set_decorations(ESLINT_SOURCE, &decorations);
                true
            }
            None => false,
        };
        if applied {
            self.inner().signals().redraw(document);
        }
    }

    /// The path, text and version of a document that ESLint could lint.
    fn lint_input(&self, document: DocumentId) -> Option<(std::path::PathBuf, String, i64)> {
        let version = self.version_of(document)?;
        let documents = self.inner().documents().lock();
        let state = &documents.get(document)?.state;
        let path = state.buffer().path()?.to_path_buf();
        Some((path, state.buffer().slice(0..state.buffer().length()), version))
    }
}
