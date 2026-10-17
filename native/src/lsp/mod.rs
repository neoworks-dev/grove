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

mod handler;
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
use handler::ServerHandler;
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
    state: Mutex<State>,
}

impl LspStore {
    /// A store that keeps servers told about `documents`, and reports through `emitter` and `signals`.
    pub fn new(documents: SharedDocuments, emitter: Emitter, signals: Signals) -> LspStore {
        let inner = Inner {
            documents: documents.clone(),
            emitter,
            signals,
            search_directories: registry::search_directories(),
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
        commands.command("lsp_status", move |_| Ok::<_, CommandError>(reader.summaries())).command(
            "lsp_restart",
            move |args| {
                let Some(id) = args.get("id").and_then(Value::as_u64) else {
                    return Err(CommandError::with_code("InvalidArguments", "this command takes a server id"));
                };
                restarter.restart(id);
                Ok(Value::Null)
            },
        )
    }

    /// Asks every server to shut down and waits a moment for them to. Called as the app exits.
    pub fn shutdown(&self) {
        let clients: Vec<Client> = self.state().servers.iter_mut().filter_map(|entry| entry.client.take()).collect();
        let threads: Vec<_> = clients
            .into_iter()
            .map(|client| std::thread::spawn(move || client.shutdown(SHUTDOWN_TIMEOUT)))
            .collect();
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
        match self.spawn(&command, root, server) {
            Ok(client) => {
                if let Some(entry) = self.state().server_mut(server) {
                    entry.client = Some(client);
                }
            }
            Err(error) => self.set_state(server, ServerState::Failed(format!("could not start {}: {error}", spec.name))),
        }
    }

    /// Starts a server process whose events come back to this store.
    fn spawn(&self, command: &ServerCommand, root: &Path, server: u64) -> std::io::Result<Client> {
        let handler = Arc::new(ServerHandler::new(Arc::downgrade(&self.inner), server));
        Client::start(command, root, root, Value::Null, handler)
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
            let Some(client) = entry.client.clone() else {
                return;
            };
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

    pub(crate) fn inner(&self) -> &Inner {
        &self.inner
    }

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
    }

    /// Sends the server what changed.
    fn changed(&self, id: DocumentId, state: &EditorState, changes: Vec<editor_core::ContentChange>) {
        let mut guard = self.state();
        let State { servers, tracked, .. } = &mut *guard;
        let Some(tracked) = tracked.get_mut(&id) else {
            return;
        };
        tracked.version += 1;
        if !tracked.open_on_server {
            return;
        }
        let Some(client) = servers.iter().find(|entry| entry.id == tracked.server).and_then(|e| e.client.as_ref()) else {
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

    /// Tells the server the file was written, when it asked to hear.
    fn saved(&self, id: DocumentId, state: &EditorState) {
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
        if let Some((client, uri)) = client {
            client.notify_document("textDocument/didClose", sync::did_close_params(&uri));
        }
    }
}
