//! Language servers, run from the host the way Zed runs them: the host starts a server for each
//! language and workspace, keeps its copy of every open file in step with the documents, shows
//! what it finds as decorations, and answers the editor's questions to it (completion, hover,
//! definition) without a hop through the UI.
//!
//! Servers start when a file of a language that has one is opened (see
//! `lsp_client::registry`), and stop when the app exits. A server that dies is shown in the
//! status bar and can be started again.
//!
//! Events, on the app's `listen` channel:
//!
//! - `lsp-status`: the list of servers, each `{ id, name, root, state, message, busy }`, sent
//!   whenever one changes. `state` is `starting`, `ready`, `failed`, `exited`, `stopped` or `missing`.
//!
//! Commands: `lsp_status` answers the same list, and `lsp_restart { id }` starts a server again.
//!
//! `GROVE_NO_LSP=1` starts no server, for comparing with the editor without them.

mod apply;
mod format;
mod handler;
mod lint;
mod settings;
mod state;

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use editor_core::{DocumentId, EditorState, Position};
use lsp_client::client::{Callback, Client, RequestId, ServerCommand};
use lsp_client::diagnostics::DIAGNOSTICS_SOURCE;
use lsp_client::protocol::Capabilities;
use lsp_client::registry::{self, FileKind};
use lsp_client::sync;
use lsp_client::uri::uri_from_path;
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

use crate::editor::{DocumentObserver, SharedDocuments, Signals};
pub use apply::Applied;
use handler::ServerHandler;
pub use settings::LspSettings;
use state::{ServerEntry, ServerState, State, Tracked};

/// How long a server is given to shut down when the app exits.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);

/// Where the answer to a request goes.
pub type Reply = Callback;

/// A request that is waiting for its answer, which can be given up on.
pub struct Pending {
    client: Client,
    id: RequestId,
}

impl Pending {
    /// Tells the server the answer is no longer wanted.
    pub fn cancel(&self) {
        self.client.cancel(self.id);
    }
}

/// Everything the host knows about language servers. Cheap to clone.
#[derive(Clone)]
pub struct LspStore {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    documents: SharedDocuments,
    emitter: Emitter,
    signals: Signals,
    search_directories: Vec<std::path::PathBuf>,
    /// Whether `GROVE_NO_LSP` is set, which starts no server at all.
    disabled: bool,
    settings: Mutex<LspSettings>,
    lint_runs: lint::LintRuns,
    state: Mutex<State>,
}

impl LspStore {
    /// A store that keeps servers told about `documents`, and reports through `emitter` and `signals`.
    pub fn new(documents: SharedDocuments, emitter: Emitter, signals: Signals) -> LspStore {
        LspStore::with_search_directories(documents, emitter, signals, registry::search_directories())
    }

    /// Like `new`, looking for servers in the given directories only.
    pub fn with_search_directories(
        documents: SharedDocuments,
        emitter: Emitter,
        signals: Signals,
        search_directories: Vec<std::path::PathBuf>,
    ) -> LspStore {
        let inner = Inner {
            documents: documents.clone(),
            emitter,
            signals,
            search_directories,
            disabled: std::env::var_os("GROVE_NO_LSP").is_some(),
            settings: Mutex::new(LspSettings::default()),
            lint_runs: lint::LintRuns::default(),
            state: Mutex::new(State::default()),
        };
        let store = LspStore { inner: Arc::new(inner) };
        documents.observe(Arc::new(store.clone()));
        store
    }

    /// Registers the commands the UI reads the servers with and starts them again with.
    pub fn register(&self, commands: Commands) -> Commands {
        let reader = self.clone();
        let restarter = self.clone();
        let configurer = self.clone();
        let watcher = self.clone();
        commands
            .command("lsp_status", move |_| Ok::<_, CommandError>(reader.summaries()))
            .command("lsp_restart", move |args| {
                let Some(id) = args.get("id").and_then(Value::as_u64) else {
                    return Err(CommandError::with_code("InvalidArguments", "this command takes a server id"));
                };
                restarter.restart(id);
                Ok(Value::Null)
            })
            .command("lsp_configure", move |args| {
                configurer.configure(&args);
                Ok::<_, CommandError>(Value::Null)
            })
            .command("lsp_files_changed", move |args| {
                watcher.files_changed(&changes_from(&args));
                Ok::<_, CommandError>(Value::Null)
            })
    }

    /// What the person has switched on, as the app last said.
    pub fn settings(&self) -> LspSettings {
        *self.inner.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Applies the settings the app sends. Servers are told when what they read changed, and
    /// the views refresh what the switches decide whether to show.
    pub fn configure(&self, arguments: &Value) {
        let before = self.settings();
        let after = before.updated_from(arguments);
        *self.inner.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = after;
        if after == before {
            return;
        }
        if after.inlay_hints != before.inlay_hints {
            self.push_configuration();
        }
        if after.eslint != before.eslint {
            self.lint_all();
        }
        self.inner.signals.settings_changed();
    }

    /// Tells every ready server its settings again, as `workspace/didChangeConfiguration`.
    fn push_configuration(&self) {
        let switches = self.settings().switches();
        let state = self.state();
        for entry in state.servers.iter().filter(|entry| entry.state == ServerState::Ready) {
            let Some(client) = &entry.client else {
                continue;
            };
            let settings = lsp_client::config::all_sections(entry.spec.name, switches);
            client.notify("workspace/didChangeConfiguration", json!({ "settings": settings }));
        }
    }

    /// Tells the servers that registered for it that files changed on disk.
    pub fn files_changed(&self, changes: &[(std::path::PathBuf, lsp_client::glob::FileChange)]) {
        if changes.is_empty() {
            return;
        }
        let state = self.state();
        for entry in state.servers.iter().filter(|entry| entry.state == ServerState::Ready) {
            let Some(client) = &entry.client else {
                continue;
            };
            let watchers = entry.watchers.iter().flat_map(|(_, watchers)| watchers);
            let watchers: Vec<_> = watchers.collect();
            let events: Vec<Value> = changes
                .iter()
                .filter(|(path, change)| watchers.iter().any(|watcher| watcher.wants(path, &entry.root, *change)))
                .map(|(path, change)| json!({ "uri": uri_from_path(path), "type": change.number() }))
                .collect();
            if !events.is_empty() {
                client.notify("workspace/didChangeWatchedFiles", json!({ "changes": events }));
            }
        }
    }

    /// Whether `GROVE_NO_LSP` keeps language features off.
    pub(crate) fn is_disabled(&self) -> bool {
        self.inner.disabled
    }

    /// The directories servers and tools are looked for in.
    pub(crate) fn search_directories(&self) -> &[std::path::PathBuf] {
        &self.inner.search_directories
    }

    /// The version of a document's text as the servers were told, which goes up with every change.
    pub fn version_of(&self, document: DocumentId) -> Option<i64> {
        self.state().tracked.get(&document).map(|tracked| tracked.version)
    }

    /// What the server last said is wrong in a document, where it touches a range.
    pub fn diagnostics_at(
        &self,
        document: DocumentId,
        range: &lsp_client::protocol::Range,
    ) -> Vec<lsp_client::protocol::Diagnostic> {
        let state = self.state();
        let Some(tracked) = state.tracked.get(&document) else {
            return Vec::new();
        };
        let touches = |diagnostic: &&lsp_client::protocol::Diagnostic| {
            diagnostic.range.start <= range.end && range.start <= diagnostic.range.end
        };
        tracked.diagnostics.iter().filter(touches).cloned().collect()
    }

    /// The URI of a document that a server has open.
    pub fn uri_of(&self, document: DocumentId) -> Option<String> {
        self.client_for(document).map(|(_, uri)| uri)
    }

    /// Asks every server to shut down and waits a moment for them to. Called as the app exits.
    pub fn shutdown(&self) {
        let clients: Vec<Client> = self.state().servers.iter_mut().filter_map(|entry| entry.client.take()).collect();
        let threads: Vec<_> =
            clients.into_iter().map(|client| std::thread::spawn(move || client.shutdown(SHUTDOWN_TIMEOUT))).collect();
        for thread in threads {
            let _ = thread.join();
        }
    }

    /// What the server of a document can do, once it is ready and has the document.
    pub fn capabilities(&self, document: DocumentId) -> Option<Capabilities> {
        let state = self.state();
        let tracked = state.tracked.get(&document)?;
        if !tracked.open_on_server {
            return None;
        }
        state.server(tracked.server)?.client.as_ref()?.capabilities()
    }

    /// Sends a request about a place in a document. Returns none when no server has the document
    /// open, and then the reply never runs.
    pub fn request_at(
        &self,
        document: DocumentId,
        at: Position,
        method: &str,
        extra: Value,
        reply: Reply,
    ) -> Option<Pending> {
        let point = self.inner.documents.lock().get(document).map(|doc| {
            let buffer = doc.state.buffer();
            buffer.utf16_point_of(buffer.offset_of(at))
        })?;
        let (client, uri) = self.client_for(document)?;
        let mut params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": point.line, "character": point.character },
        });
        if let (Some(target), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            target.extend(extra.clone());
        }
        let id = client.request(method, params, reply);
        Some(Pending { client, id })
    }

    /// Sends a request that is not about a place, such as resolving a completion item, to the
    /// server of a document.
    pub fn request_for(&self, document: DocumentId, method: &str, params: Value, reply: Reply) -> Option<Pending> {
        let (client, _) = self.client_for(document)?;
        let id = client.request(method, params, reply);
        Some(Pending { client, id })
    }

    /// The client of the server that has a document open, and the document's URI.
    fn client_for(&self, document: DocumentId) -> Option<(Client, String)> {
        let state = self.state();
        let tracked = state.tracked.get(&document)?;
        if !tracked.open_on_server {
            return None;
        }
        let client = state.server(tracked.server)?.client.clone()?;
        Some((client, tracked.uri.clone()))
    }

    /// Starts a server again, and tells it about the documents it had.
    pub fn restart(&self, server: u64) {
        let documents = self.inner.documents.lock();
        let (spec, root, old) = {
            let mut state = self.state();
            let Some(entry) = state.server_mut(server) else {
                return;
            };
            entry.state = ServerState::Starting;
            entry.progress.clear();
            let old = entry.client.take();
            for tracked in state.tracked.values_mut().filter(|tracked| tracked.server == server) {
                tracked.open_on_server = false;
            }
            let Some(entry) = state.server(server) else {
                return;
            };
            (entry.spec, entry.root.clone(), old)
        };
        if let Some(old) = old {
            old.kill();
        }
        self.start_client(server, spec, &root);
        drop(documents);
        self.emit_status();
    }

    /// The servers as the UI sees them.
    pub fn summaries(&self) -> Value {
        let state = self.state();
        Value::Array(state.servers.iter().map(ServerEntry::summary).collect())
    }

    /// Tells the UI how the servers are doing.
    pub(crate) fn emit_status(&self) {
        let summaries = self.summaries();
        if std::env::var_os("GROVE_LSP_TRACE").is_some() {
            eprintln!("[lsp] status {summaries}");
        }
        self.inner.emitter.emit("lsp-status", summaries);
    }

    /// Locks the state, carrying on after a thread that held it panicked.
    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The server for a kind of file in a workspace, made and started if there is none yet.
    /// Called with the documents locked, so the server cannot say it is ready before it is stored.
    fn server_for(&self, kind: &'static FileKind, root: &Path) -> u64 {
        let created = {
            let mut state = self.state();
            if let Some(existing) = state.find_server(kind.server, root) {
                return existing;
            }
            let id = state.next_server_id();
            state.servers.push(ServerEntry {
                id,
                spec: kind.server,
                root: root.to_path_buf(),
                client: None,
                state: ServerState::Starting,
                watchers: Vec::new(),
                progress: Default::default(),
                last_emitted: Instant::now(),
            });
            id
        };
        self.start_client(created, kind.server, root);
        created
    }

    /// Starts the process of a server entry, or records why it could not be.
    fn start_client(&self, server: u64, spec: &'static registry::Server, root: &Path) {
        let Some(command) = registry::command_for(spec, &self.inner.search_directories) else {
            let message = format!("{} was not found; install it to get completions and diagnostics here", spec.name);
            self.set_state(server, ServerState::Missing(message));
            return;
        };
        match self.spawn(&command, root, server, spec.name) {
            Ok(client) => {
                if let Some(entry) = self.state().server_mut(server) {
                    entry.client = Some(client);
                }
            }
            Err(error) => {
                self.set_state(server, ServerState::Failed(format!("could not start {}: {error}", spec.name)))
            }
        }
    }

    /// Starts a server process whose events come back to this store.
    fn spawn(&self, command: &ServerCommand, root: &Path, server: u64, name: &str) -> std::io::Result<Client> {
        let handler = Arc::new(ServerHandler::new(Arc::downgrade(&self.inner), server));
        let options = lsp_client::config::initialization_options(name, self.settings().switches());
        Client::start(command, root, root, options, handler)
    }

    /// Records a server's state without telling the UI.
    fn set_state(&self, server: u64, new_state: ServerState) {
        if let Some(entry) = self.state().server_mut(server) {
            entry.state = new_state;
        }
    }

    /// Tells a server that has just become ready about the documents it is to know of. Holds the
    /// documents locked, so no change slips in between reading a text and recording that it was sent.
    pub(crate) fn server_ready(&self, server: u64) {
        let documents = self.inner.documents.lock();
        {
            let mut state = self.state();
            let Some(entry) = state.server_mut(server) else {
                return;
            };
            entry.state = ServerState::Ready;
            entry.watchers.clear();
            let Some(client) = entry.client.clone() else {
                return;
            };
            let switches = self.settings().switches();
            let settings = lsp_client::config::all_sections(entry.spec.name, switches);
            client.notify("workspace/didChangeConfiguration", json!({ "settings": settings }));
            for (id, tracked) in state.tracked.iter_mut().filter(|(_, tracked)| tracked.server == server) {
                let Some(document) = documents.get(*id) else {
                    continue;
                };
                send_open(&client, tracked, &document.state);
            }
        }
        drop(documents);
        self.emit_status();
    }

    /// A server ended or failed: its documents are no longer open on it, and what it reported goes away.
    pub(crate) fn server_gone(&self, server: u64, new_state: ServerState) {
        let affected: Vec<DocumentId> = {
            let mut state = self.state();
            if let Some(entry) = state.server_mut(server) {
                entry.state = new_state;
                entry.progress.clear();
            }
            let tracked = state.tracked.iter_mut().filter(|(_, tracked)| tracked.server == server);
            tracked
                .map(|(id, tracked)| {
                    tracked.open_on_server = false;
                    *id
                })
                .collect()
        };
        for id in affected {
            self.clear_diagnostics(id);
        }
        self.emit_status();
    }

    /// Takes the diagnostics off a document and redraws it.
    pub(crate) fn clear_diagnostics(&self, document: DocumentId) {
        let cleared = match self.inner.documents.lock().get_mut(document) {
            Some(doc) => {
                doc.state.set_decorations(DIAGNOSTICS_SOURCE, &[]);
                true
            }
            None => false,
        };
        if cleared {
            self.inner.signals.redraw(document);
        }
    }

    /// The shared state, for the server handlers.
    pub(crate) fn inner(&self) -> &Inner {
        &self.inner
    }

    /// The store that owns some shared state.
    pub(crate) fn from_inner(inner: Arc<Inner>) -> LspStore {
        LspStore { inner }
    }
}

impl Inner {
    /// The documents the store keeps servers told about.
    pub(crate) fn documents(&self) -> &SharedDocuments {
        &self.documents
    }

    /// Where views are told to redraw.
    pub(crate) fn signals(&self) -> &Signals {
        &self.signals
    }
}

/// The file changes the app reports, as `{ changes: [{ path, kind }] }` with `kind` one of
/// `created`, `changed` and `deleted`. Entries that do not read are left out.
fn changes_from(arguments: &Value) -> Vec<(std::path::PathBuf, lsp_client::glob::FileChange)> {
    use lsp_client::glob::FileChange;
    let Some(list) = arguments.get("changes").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    for entry in list {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        let change = match entry.get("kind").and_then(Value::as_str) {
            Some("created") => FileChange::Created,
            Some("changed") => FileChange::Changed,
            Some("deleted") => FileChange::Deleted,
            _ => continue,
        };
        changes.push((std::path::PathBuf::from(path), change));
    }
    changes
}

/// Sends `didOpen` for a document and records that the server has it.
fn send_open(client: &Client, tracked: &mut Tracked, state: &EditorState) {
    let buffer = state.buffer();
    let text = buffer.slice(0..buffer.length());
    let params = sync::did_open_params(&tracked.uri, tracked.language_id, tracked.version, &text);
    client.notify_document("textDocument/didOpen", params);
    tracked.open_on_server = true;
}

impl DocumentObserver for LspStore {
    /// Starts tracking a file a server serves, and opens it on the server if that is ready.
    fn opened(&self, id: DocumentId, state: &EditorState) {
        if self.inner.disabled {
            return;
        }
        let Some(path) = state.buffer().path() else {
            return;
        };
        let Some(kind) = registry::file_kind(path) else {
            return;
        };
        let root = registry::workspace_root(path, kind.server);
        let server = self.server_for(kind, &root);
        let mut tracked = Tracked {
            uri: uri_from_path(path),
            language_id: kind.language_id,
            server,
            version: 1,
            open_on_server: false,
            diagnostics: Vec::new(),
        };
        let client = {
            let state = self.state();
            match state.server(server) {
                Some(entry) if entry.state == ServerState::Ready => entry.client.clone(),
                _ => None,
            }
        };
        if let Some(client) = client {
            send_open(&client, &mut tracked, state);
        }
        self.state().tracked.insert(id, tracked);
        self.emit_status();
        self.lint_soon(id, Duration::ZERO);
    }

    /// Sends the server what changed.
    fn changed(&self, id: DocumentId, state: &EditorState, changes: Vec<editor_core::ContentChange>) {
        let mut guard = self.state();
        let State { servers, tracked, .. } = &mut *guard;
        let Some(tracked) = tracked.get_mut(&id) else {
            return;
        };
        tracked.version += 1;
        self.lint_after_typing(id);
        if !tracked.open_on_server {
            return;
        }
        let Some(client) = servers.iter().find(|entry| entry.id == tracked.server).and_then(|e| e.client.as_ref())
        else {
            return;
        };
        let Some(capabilities) = client.capabilities() else {
            return;
        };
        let buffer = state.buffer();
        let full_text = || buffer.slice(0..buffer.length());
        let params = sync::did_change_params(&tracked.uri, tracked.version, capabilities.sync, &changes, full_text);
        if let Some(params) = params {
            client.notify_document("textDocument/didChange", params);
        }
    }

    /// Formats the file before it is written, when the person wants that.
    fn before_save(&self, id: DocumentId) {
        if self.inner.disabled {
            return;
        }
        self.format_before_saving(id);
    }

    /// Tells the server the file was written, when it asked to hear, and lints it again.
    fn saved(&self, id: DocumentId, state: &EditorState) {
        self.lint_soon(id, Duration::ZERO);
        let Some((client, uri)) = self.client_for(id) else {
            return;
        };
        let Some(capabilities) = client.capabilities() else {
            return;
        };
        if !capabilities.wants_save {
            return;
        }
        let buffer = state.buffer();
        let text = buffer.slice(0..buffer.length());
        let included = if capabilities.wants_text_on_save { Some(text.as_str()) } else { None };
        client.notify_document("textDocument/didSave", sync::did_save_params(&uri, included));
    }

    /// Tells the server the document is closed, and forgets it.
    fn closed(&self, id: DocumentId) {
        let client = self.client_for(id);
        self.state().tracked.remove(&id);
        self.inner.lint_runs.forget(id);
        if let Some((client, uri)) = client {
            client.notify_document("textDocument/didClose", sync::did_close_params(&uri));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Command, Position};
    use std::path::PathBuf;

    /// How long a test waits for a server before it gives up.
    const WAIT: Duration = Duration::from_secs(10);

    /// A directory with a Rust crate in it and a `rust-analyzer` that is the test server, or none
    /// when the server binary was not built beside the tests.
    struct Fixture {
        directory: PathBuf,
        servers: PathBuf,
    }

    fn fixture(name: &str, source: &str) -> Option<Fixture> {
        let executable = std::env::current_exe().ok()?;
        let fake = executable.parent()?.parent()?.join("fake_lsp");
        if !fake.exists() {
            eprintln!("skipping: {} is not built", fake.display());
            return None;
        }
        let root = std::env::temp_dir().join(format!("grove-lsp-store-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let directory = root.join("crate");
        let servers = root.join("servers");
        std::fs::create_dir_all(directory.join("src")).ok()?;
        std::fs::create_dir_all(&servers).ok()?;
        std::fs::write(directory.join("Cargo.toml"), "[package]\nname = \"demo\"\n").ok()?;
        std::fs::write(directory.join("src/main.rs"), source).ok()?;
        std::os::unix::fs::symlink(&fake, servers.join("rust-analyzer")).ok()?;
        Some(Fixture { directory, servers })
    }

    fn store_for(fixture: &Fixture) -> (SharedDocuments, LspStore) {
        let documents = SharedDocuments::new(Emitter::default());
        let store = LspStore::with_search_directories(
            documents.clone(),
            Emitter::default(),
            Signals::default(),
            vec![fixture.servers.clone()],
        );
        (documents, store)
    }

    /// Waits until `condition` holds, or fails the test.
    fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if condition() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }

    fn state_of(store: &LspStore) -> String {
        store.summaries()[0]["state"].as_str().unwrap_or_default().to_string()
    }

    #[test]
    fn opening_a_file_starts_its_server_and_the_servers_findings_decorate_it() {
        let Some(fixture) = fixture("decorate", "fn main() {}\nlet BAD = 1;\n") else {
            return;
        };
        let (documents, store) = store_for(&fixture);
        let id = documents.open(&fixture.directory.join("src/main.rs").display().to_string()).unwrap().id;
        let decorations = |documents: &SharedDocuments| {
            documents.lock().get(id).map(|doc| doc.state.decoration_count(DIAGNOSTICS_SOURCE)).unwrap_or(0)
        };
        wait_until("the diagnostic", || decorations(&documents) == 2);
        assert_eq!(state_of(&store), "ready");
        assert_eq!(store.summaries()[0]["name"], "rust-analyzer");

        // A second BAD typed at the end reaches the server as a change, and its answer decorates it.
        documents.apply(id, &Command::PlaceCursor { at: Position { row: 1, column: 12 } }).unwrap();
        documents.apply(id, &Command::InsertText { text: " BAD".into() }).unwrap();
        wait_until("the second diagnostic", || decorations(&documents) == 3);
        store.shutdown();
    }

    #[test]
    fn diagnostics_follow_the_text_the_server_was_told_about() {
        let Some(fixture) = fixture("follow", "ok\nBAD\n") else {
            return;
        };
        let (documents, store) = store_for(&fixture);
        let id = documents.open(&fixture.directory.join("src/main.rs").display().to_string()).unwrap().id;
        let squiggle_row = |documents: &SharedDocuments| {
            let documents = documents.lock();
            let state = &documents.get(id)?.state;
            let placed = state.decorations_in_rows(0..10);
            placed.iter().find(|placed| placed.tooltip.is_some()).map(|placed| placed.start.row)
        };
        wait_until("the diagnostic", || squiggle_row(&documents) == Some(1));
        documents.apply(id, &Command::InsertText { text: "new line\n".into() }).unwrap();
        wait_until("the diagnostic to move down", || squiggle_row(&documents) == Some(2));
        store.shutdown();
    }

    #[test]
    fn a_server_that_crashes_is_reported_and_can_be_started_again() {
        let Some(fixture) = fixture("crash", "fine\n") else {
            return;
        };
        let (documents, store) = store_for(&fixture);
        let id = documents.open(&fixture.directory.join("src/main.rs").display().to_string()).unwrap().id;
        wait_until("the server to be ready", || state_of(&store) == "ready");
        documents.apply(id, &Command::InsertText { text: "CRASH".into() }).unwrap();
        wait_until("the crash to be noticed", || state_of(&store) == "exited");
        let message = store.summaries()[0]["message"].as_str().unwrap_or_default().to_string();
        assert!(message.contains("crashed on purpose"), "{message}");

        let server = store.summaries()[0]["id"].as_u64().unwrap();
        documents.apply(id, &Command::Undo).unwrap();
        store.restart(server);
        wait_until("the restarted server to be ready", || state_of(&store) == "ready");
        store.shutdown();
    }

    /// What the fake server wrote to its log, one note per line.
    fn notes(fixture: &Fixture) -> String {
        std::fs::read_to_string(fixture.directory.join("fake-lsp.log")).unwrap_or_default()
    }

    #[test]
    fn the_server_is_answered_from_the_settings_and_hears_of_the_files_it_asked_for() {
        let Some(fixture) = fixture("watch", "fn main() {}\n") else {
            return;
        };
        let (documents, store) = store_for(&fixture);
        documents.open(&fixture.directory.join("src/main.rs").display().to_string()).unwrap();
        wait_until("the configuration answer", || notes(&fixture).contains("configuration answered"));
        let answered = notes(&fixture);
        assert!(answered.contains("[null,{\"inlayHints\""), "{answered}");
        assert!(answered.contains("\"typeHints\":{\"enable\":true}"), "{answered}");
        wait_until("the configuration push", || notes(&fixture).contains("configuration pushed"));

        let watched = fixture.directory.join("src/a.watched");
        let ignored = fixture.directory.join("src/b.txt");
        use lsp_client::glob::FileChange;
        store.files_changed(&[(watched.clone(), FileChange::Created), (ignored, FileChange::Changed)]);
        wait_until("the watched file to be heard of", || notes(&fixture).contains("a.watched 1"));
        assert!(!notes(&fixture).contains("b.txt"));

        store.configure(&json!({ "inlayHints": false }));
        wait_until("the settings to be pushed", || notes(&fixture).contains("\"typeHints\":{\"enable\":false}"));
        store.shutdown();
    }

    #[test]
    fn saving_formats_with_the_server_when_the_project_has_no_prettier_and_can_be_switched_off() {
        let Some(fixture) = fixture("format", "fn main() {}   \nlet x = 1;  \n") else {
            return;
        };
        let (documents, store) = store_for(&fixture);
        let path = fixture.directory.join("src/main.rs");
        let id = documents.open(&path.display().to_string()).unwrap().id;
        wait_until("the server to be ready", || state_of(&store) == "ready");
        documents.apply(id, &Command::InsertText { text: "// ".into() }).unwrap();
        let outcome = documents.apply(id, &Command::Save).unwrap();
        assert!(outcome.saved);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "// fn main() {}\nlet x = 1;\n");
        assert_eq!(documents.text(id).unwrap(), "// fn main() {}\nlet x = 1;\n");

        store.configure(&json!({ "formatOnSave": false }));
        documents.apply(id, &Command::PlaceCursor { at: Position { row: 0, column: 0 } }).unwrap();
        documents.apply(id, &Command::InsertText { text: "x   \n".into() }).unwrap();
        documents.apply(id, &Command::Save).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("x   \n"));
        let formatted = store.format(id, WAIT).unwrap().unwrap();
        assert_eq!(formatted, super::format::Formatted { formatter: "the language server", changed: true });
        documents.apply(id, &Command::Undo).unwrap();
        assert!(documents.text(id).unwrap().starts_with("x   \n"), "one undo takes the whole format back");
        store.shutdown();
    }

    #[test]
    fn eslint_findings_decorate_the_file_and_go_when_the_switch_is_turned_off() {
        let directory = std::env::temp_dir().join(format!("grove-lsp-lint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let tools = directory.join("tools");
        std::fs::create_dir_all(directory.join("src")).unwrap();
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::write(directory.join("eslint.config.mjs"), "export default []").unwrap();
        std::fs::write(directory.join("src/a.ts"), "let a = 1\n").unwrap();
        let report =
            r#"[{"messages":[{"ruleId":"semi","severity":2,"message":"Missing semicolon","line":1,"column":10}]}]"#;
        let script = tools.join("eslint_d");
        std::fs::write(&script, format!("#!/bin/sh\ncat >/dev/null\necho '{report}'\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let documents = SharedDocuments::new(Emitter::default());
        let store =
            LspStore::with_search_directories(documents.clone(), Emitter::default(), Signals::default(), vec![tools]);
        let id = documents.open(&directory.join("src/a.ts").display().to_string()).unwrap().id;
        let count = |documents: &SharedDocuments| {
            documents.lock().get(id).map(|doc| doc.state.decoration_count(lint::ESLINT_SOURCE)).unwrap_or(0)
        };
        wait_until("the lint", || count(&documents) == 2);
        store.configure(&json!({ "eslint": false }));
        wait_until("the lint to be taken off", || count(&documents) == 0);
        store.configure(&json!({ "eslint": true }));
        wait_until("the lint to come back", || count(&documents) == 2);
    }

    #[test]
    fn a_file_no_server_serves_is_left_alone_and_a_missing_server_is_said_to_be_missing() {
        let Some(fixture) = fixture("missing", "text\n") else {
            return;
        };
        std::fs::write(fixture.directory.join("notes.txt"), "BAD\n").unwrap();
        let (documents, store) = store_for(&fixture);
        documents.open(&fixture.directory.join("notes.txt").display().to_string()).unwrap();
        assert_eq!(store.summaries(), json!([]));
        let empty = SharedDocuments::new(Emitter::default());
        let nowhere =
            LspStore::with_search_directories(empty.clone(), Emitter::default(), Signals::default(), Vec::new());
        empty.open(&fixture.directory.join("src/main.rs").display().to_string()).unwrap();
        assert_eq!(state_of(&nowhere), "missing");
        assert!(nowhere.summaries()[0]["message"].as_str().unwrap().contains("not found"));
    }
}
