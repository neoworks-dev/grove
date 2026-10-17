//! What the store knows: the servers it has started, and the documents it keeps them told about.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Instant;

use editor_core::DocumentId;
use lsp_client::client::{Client, Status};
use lsp_client::registry::Server;
use serde_json::{Value, json};

/// How a server is doing, as the status bar tells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerState {
    Starting,
    Ready,
    /// Could not start or initialize. Carries the reason.
    Failed(String),
    /// Ended without being asked to. Carries the end of what it wrote to stderr.
    Exited(String),
    /// Ended after being asked to.
    Stopped,
    /// No program for it was found. Carries what to install.
    Missing(String),
}

impl ServerState {
    /// The name the UI knows the state by.
    pub fn name(&self) -> &'static str {
        match self {
            ServerState::Starting => "starting",
            ServerState::Ready => "ready",
            ServerState::Failed(_) => "failed",
            ServerState::Exited(_) => "exited",
            ServerState::Stopped => "stopped",
            ServerState::Missing(_) => "missing",
        }
    }

    /// What goes with the state: the reason it failed, if it did.
    pub fn message(&self) -> &str {
        match self {
            ServerState::Failed(message) | ServerState::Exited(message) | ServerState::Missing(message) => message,
            _ => "",
        }
    }

    /// The state a client's status stands for.
    pub fn from_status(status: &Status) -> ServerState {
        match status {
            Status::Starting => ServerState::Starting,
            Status::Ready => ServerState::Ready,
            Status::Failed(message) => ServerState::Failed(message.clone()),
            Status::Exited(message) => ServerState::Exited(message.clone()),
            Status::Stopped => ServerState::Stopped,
        }
    }
}

/// One server for one workspace.
pub struct ServerEntry {
    pub id: u64,
    pub spec: &'static Server,
    pub root: PathBuf,
    pub client: Option<Client>,
    pub state: ServerState,
    /// The work the server reports being busy with, by progress token.
    pub progress: BTreeMap<String, String>,
    /// When the status was last sent to the UI, so progress reports do not flood it.
    pub last_emitted: Instant,
}

impl ServerEntry {
    /// What the server is busy with, if it says.
    pub fn busy_with(&self) -> Option<&str> {
        self.progress.values().next_back().map(String::as_str)
    }

    /// The entry as the UI sees it.
    pub fn summary(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.spec.name,
            "root": self.root.display().to_string(),
            "state": self.state.name(),
            "message": self.state.message(),
            "busy": self.busy_with(),
        })
    }
}

/// A document the servers are told about.
pub struct Tracked {
    pub uri: String,
    pub language_id: &'static str,
    pub server: u64,
    /// Goes up with every change, so the server and the editor agree on which text is meant.
    pub version: i64,
    /// Whether the server has been sent `didOpen` and has not been closed or restarted since.
    pub open_on_server: bool,
}

/// All of it, behind one lock.
#[derive(Default)]
pub struct State {
    pub servers: Vec<ServerEntry>,
    pub tracked: HashMap<DocumentId, Tracked>,
    next_server_id: u64,
}

impl State {
    /// The id for the next server.
    pub fn next_server_id(&mut self) -> u64 {
        self.next_server_id += 1;
        self.next_server_id
    }

    /// A server by id.
    pub fn server(&self, id: u64) -> Option<&ServerEntry> {
        self.servers.iter().find(|entry| entry.id == id)
    }

    /// A server by id, to change.
    pub fn server_mut(&mut self, id: u64) -> Option<&mut ServerEntry> {
        self.servers.iter_mut().find(|entry| entry.id == id)
    }

    /// The server for a spec and a workspace, if one was made.
    pub fn find_server(&self, spec: &Server, root: &std::path::Path) -> Option<u64> {
        self.servers.iter().find(|entry| entry.spec.name == spec.name && entry.root == root).map(|entry| entry.id)
    }

    /// The server a document is tracked by.
    pub fn server_of(&self, document: DocumentId) -> Option<&ServerEntry> {
        let tracked = self.tracked.get(&document)?;
        self.server(tracked.server)
    }
}
