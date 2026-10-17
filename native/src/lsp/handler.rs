//! What a server says without being asked: its status, the diagnostics it publishes, the
//! progress it reports, and the requests it makes of the client.

use std::sync::Weak;
use std::time::{Duration, Instant};

use lsp_client::client::{Handler, Status};
use lsp_client::diagnostics::{DIAGNOSTICS_SOURCE, decorations_for};
use lsp_client::protocol::{METHOD_NOT_FOUND, PublishDiagnostics, ResponseError};
use lsp_client::uri::path_from_uri;
use serde_json::{Value, json};

use super::state::ServerState;
use super::{Inner, LspStore};

/// The least time between two reports of a server's progress to the UI.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// Receives the events of one server and passes them to the store. Holds the store weakly, so a
/// server's threads never keep it alive.
pub struct ServerHandler {
    store: Weak<Inner>,
    server: u64,
}

impl ServerHandler {
    /// A handler for the server with this id.
    pub fn new(store: Weak<Inner>, server: u64) -> ServerHandler {
        ServerHandler { store, server }
    }

    /// The store, unless it is gone.
    fn store(&self) -> Option<LspStore> {
        self.store.upgrade().map(LspStore::from_inner)
    }
}

impl Handler for ServerHandler {
    /// Takes diagnostics and progress; other notifications are ignored.
    fn notification(&self, method: &str, params: Value) {
        let Some(store) = self.store() else {
            return;
        };
        match method {
            "textDocument/publishDiagnostics" => store.diagnostics_published(&params),
            "$/progress" => store.progress_reported(self.server, &params),
            "window/logMessage" | "window/showMessage" => trace(&params),
            _ => {}
        }
    }

    /// Answers what servers commonly ask of a client: its settings, workspace and registrations.
    fn request(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        match method {
            "workspace/configuration" => {
                let sections = params["items"].as_array().map(Vec::len).unwrap_or(0);
                Ok(Value::Array(vec![Value::Null; sections]))
            }
            "workspace/workspaceFolders" => Ok(self.workspace_folders()),
            "window/workDoneProgress/create" | "client/registerCapability" | "client/unregisterCapability" => {
                Ok(Value::Null)
            }
            "window/showMessageRequest" => Ok(Value::Null),
            "workspace/applyEdit" => {
                Ok(json!({ "applied": false, "failureReason": "the editor does not apply server edits yet" }))
            }
            _ => Err(ResponseError { code: METHOD_NOT_FOUND, message: format!("the editor has no {method}") }),
        }
    }

    /// Tells the store when the server is ready or gone.
    fn status(&self, status: &Status) {
        let Some(store) = self.store() else {
            return;
        };
        match status {
            Status::Starting => {}
            Status::Ready => store.server_ready(self.server),
            other => store.server_gone(self.server, ServerState::from_status(other)),
        }
    }
}

impl ServerHandler {
    /// The workspace folder of the server, as the answer to its request for them.
    fn workspace_folders(&self) -> Value {
        let Some(store) = self.store() else {
            return Value::Null;
        };
        let state = store.state();
        let Some(entry) = state.server(self.server) else {
            return Value::Null;
        };
        let uri = lsp_client::uri::uri_from_path(&entry.root);
        json!([{ "uri": uri, "name": entry.root.file_name().map(|name| name.to_string_lossy().into_owned()) }])
    }
}

/// Prints what a server logs, when `GROVE_LSP_TRACE` is set.
fn trace(params: &Value) {
    if std::env::var_os("GROVE_LSP_TRACE").is_none() {
        return;
    }
    eprintln!("[lsp] {}", params["message"].as_str().unwrap_or_default());
}

impl LspStore {
    /// Puts the diagnostics a server published on the document they are about, unless the
    /// document has changed since the server looked at it.
    fn diagnostics_published(&self, params: &Value) {
        let Ok(published) = serde_json::from_value::<PublishDiagnostics>(params.clone()) else {
            return;
        };
        let Some(path) = path_from_uri(&published.uri) else {
            return;
        };
        let Some(document) = self.inner().documents().lock().find_by_path(&path) else {
            return;
        };
        if self.diagnostics_are_stale(document, published.version) {
            return;
        }
        let applied = match self.inner().documents().lock().get_mut(document) {
            Some(doc) => {
                let decorations = decorations_for(doc.state.buffer(), &published.diagnostics);
                doc.state.set_decorations(DIAGNOSTICS_SOURCE, &decorations);
                true
            }
            None => false,
        };
        if applied {
            self.inner().signals().redraw(document);
        }
    }

    /// Whether diagnostics for a version of a document are older than the document's text.
    fn diagnostics_are_stale(&self, document: u64, version: Option<i64>) -> bool {
        let Some(version) = version else {
            return false;
        };
        match self.state().tracked.get(&document) {
            Some(tracked) => version < tracked.version,
            None => true,
        }
    }

    /// Notes what a server says it is busy with, and tells the UI now and then.
    fn progress_reported(&self, server: u64, params: &Value) {
        let token = match &params["token"] {
            Value::String(token) => token.clone(),
            other => other.to_string(),
        };
        let value = &params["value"];
        let changed = {
            let mut state = self.state();
            let Some(entry) = state.server_mut(server) else {
                return;
            };
            match value["kind"].as_str() {
                Some("end") => {
                    entry.progress.remove(&token);
                }
                Some(_) => {
                    let text = progress_text(value, entry.progress.get(&token));
                    entry.progress.insert(token, text);
                }
                None => return,
            }
            let due = entry.last_emitted.elapsed() >= PROGRESS_INTERVAL || value["kind"] == "end";
            if due {
                entry.last_emitted = Instant::now();
            }
            due
        };
        if changed {
            self.emit_status();
        }
    }
}

/// What a progress report says, such as `Indexing 12/300`. A report that adds nothing keeps the
/// text from the one before it.
fn progress_text(value: &Value, previous: Option<&String>) -> String {
    let title = value["title"].as_str().map(str::to_string);
    let message = value["message"].as_str().filter(|message| !message.is_empty());
    let percentage = value["percentage"].as_u64();
    let head = match (title, previous) {
        (Some(title), _) => title,
        (None, Some(previous)) => previous.split(": ").next().unwrap_or_default().to_string(),
        (None, None) => String::new(),
    };
    match (message, percentage) {
        (Some(message), _) => format!("{head}: {message}"),
        (None, Some(percentage)) => format!("{head}: {percentage}%"),
        (None, None) => head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_keeps_its_title_across_reports() {
        let begin = json!({ "kind": "begin", "title": "Indexing" });
        let first = progress_text(&begin, None);
        assert_eq!(first, "Indexing");
        let report = json!({ "kind": "report", "message": "3/10" });
        assert_eq!(progress_text(&report, Some(&first)), "Indexing: 3/10");
        let percentage = json!({ "kind": "report", "percentage": 40 });
        assert_eq!(progress_text(&percentage, Some(&first)), "Indexing: 40%");
    }
}
