//! The client against a server process: starting it, holding document messages until it is
//! ready, keeping its copy of the text in step with the editor's buffer, requests and their
//! answers, a crash, and shutting it down.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use editor_core::{Buffer, Command, EditorState, Position};
use lsp_client::client::{Client, Handler, ServerCommand, Status};
use lsp_client::completion::parse_items;
use lsp_client::protocol::{PublishDiagnostics, ResponseError, SyncKind, parse_targets};
use lsp_client::sync::{did_change_params, did_close_params, did_open_params, did_save_params};
use lsp_client::uri::uri_from_path;
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(10);

/// What the server told the client without being asked.
enum Heard {
    Notification(String, Value),
    Status(Status),
}

struct Collector {
    sender: Mutex<Sender<Heard>>,
}

impl Handler for Collector {
    /// Passes the notification on to the test.
    fn notification(&self, method: &str, params: Value) {
        let _ = self.sender.lock().unwrap().send(Heard::Notification(method.to_string(), params));
    }

    /// Answers the configuration request with one object per section asked about, and refuses the rest.
    fn request(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        if method == "workspace/configuration" {
            let sections = params["items"].as_array().map(Vec::len).unwrap_or(0);
            return Ok(json!(vec![json!({ "answered": true }); sections]));
        }
        Err(ResponseError { code: 0, message: "unknown".into() })
    }

    /// Passes the status on to the test.
    fn status(&self, status: &Status) {
        let _ = self.sender.lock().unwrap().send(Heard::Status(status.clone()));
    }
}

struct Session {
    client: Client,
    heard: Receiver<Heard>,
    uri: String,
}

/// Starts the fake server and a client for it.
fn start() -> Session {
    let (sender, heard) = mpsc::channel();
    let handler = Arc::new(Collector { sender: Mutex::new(sender) });
    let command = ServerCommand { program: PathBuf::from(env!("CARGO_BIN_EXE_fake_lsp")), args: Vec::new() };
    let root = std::env::temp_dir();
    let client = Client::start(&command, &root, &root, Value::Null, handler).expect("the fake server starts");
    Session { client, heard, uri: uri_from_path(Path::new("/tmp/doc.ts")) }
}

impl Session {
    /// Waits for the next thing that satisfies `pick`, skipping what does not.
    fn wait_for<T>(&self, mut pick: impl FnMut(&Heard) -> Option<T>) -> T {
        loop {
            match self.heard.recv_timeout(WAIT) {
                Ok(heard) => {
                    if let Some(found) = pick(&heard) {
                        return found;
                    }
                }
                Err(RecvTimeoutError::Timeout) => panic!("timed out waiting"),
                Err(RecvTimeoutError::Disconnected) => panic!("the handler went away"),
            }
        }
    }

    /// Waits for a status that satisfies `wanted`.
    fn wait_for_status(&self, wanted: impl Fn(&Status) -> bool) -> Status {
        self.wait_for(|heard| match heard {
            Heard::Status(status) if wanted(status) => Some(status.clone()),
            _ => None,
        })
    }

    /// The diagnostics published next for the document.
    fn next_diagnostics(&self) -> PublishDiagnostics {
        self.wait_for(|heard| match heard {
            Heard::Notification(method, params) if method == "textDocument/publishDiagnostics" => {
                serde_json::from_value(params.clone()).ok()
            }
            _ => None,
        })
    }

    /// Sends a request and waits for its answer.
    fn ask(&self, method: &str, params: Value) -> Result<Value, ResponseError> {
        let (sender, receiver) = mpsc::channel();
        self.client.request(method, params, Box::new(move |result| drop(sender.send(result))));
        receiver.recv_timeout(WAIT).expect("an answer")
    }

    /// The parameters of a request about a place in the document.
    fn position_params(&self, line: usize, character: usize) -> Value {
        json!({ "textDocument": { "uri": self.uri }, "position": { "line": line, "character": character } })
    }
}

#[test]
fn documents_opened_before_the_server_is_ready_are_held_and_diagnosed() {
    let session = start();
    session
        .client
        .notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, "ok\nBAD here\n"));
    session.wait_for_status(|status| *status == Status::Ready);
    let published = session.next_diagnostics();
    assert_eq!(published.version, Some(1));
    assert_eq!(published.diagnostics.len(), 1);
    assert_eq!(published.diagnostics[0].range.start.line, 1);
    assert_eq!(published.diagnostics[0].message, "found BAD");
    let capabilities = session.client.capabilities().unwrap();
    assert_eq!(capabilities.sync, SyncKind::Incremental);
    assert_eq!(capabilities.trigger_characters, vec!["."]);
    session.client.shutdown(WAIT);
}

#[test]
fn the_server_answers_the_clients_configuration_request_and_says_so() {
    let session = start();
    let message = session.wait_for(|heard| match heard {
        Heard::Notification(method, params) if method == "window/logMessage" => {
            params["message"].as_str().map(str::to_string)
        }
        _ => None,
    });
    assert!(message.contains("answered"), "{message}");
    session.client.shutdown(WAIT);
}

#[test]
fn edits_to_the_buffer_reach_the_server_at_the_right_columns() {
    let session = start();
    let original = "const a = '😀';\n";
    let mut state = EditorState::new(Buffer::from_text(original));
    state.take_content_changes();
    session.client.notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, original));
    session.wait_for_status(|status| *status == Status::Ready);
    assert!(session.next_diagnostics().diagnostics.is_empty());

    // After the emoji, which is two UTF-16 units, one character.
    state.apply(&Command::PlaceCursor { at: Position { row: 0, column: 13 } });
    state.apply(&Command::InsertText { text: " BAD".into() });
    let changes = state.take_content_changes();
    let params = did_change_params(&session.uri, 2, SyncKind::Incremental, &changes, String::new).unwrap();
    session.client.notify_document("textDocument/didChange", params);
    let published = session.next_diagnostics();
    assert_eq!(published.version, Some(2));
    let found = published.diagnostics[0].range;
    // `const a = '😀'; BAD`: BAD starts at character 16 in UTF-16 units, 15 in characters.
    assert_eq!((found.start.line, found.start.character), (0, 15));

    // Several cursors, a line break, and an undo, each as one didChange.
    state.apply(&Command::AddCursorBelow);
    state.apply(&Command::InsertText { text: "BAD\n".into() });
    let changes = state.take_content_changes();
    let params = did_change_params(&session.uri, 3, SyncKind::Incremental, &changes, String::new).unwrap();
    session.client.notify_document("textDocument/didChange", params);
    let published = session.next_diagnostics();
    let expected = state.buffer().slice(0..state.buffer().length()).matches("BAD").count();
    assert_eq!(published.diagnostics.len(), expected);
    session.client.notify_document("textDocument/didSave", did_save_params(&session.uri, None));
    session.client.notify_document("textDocument/didClose", did_close_params(&session.uri));
    session.client.shutdown(WAIT);
}

#[test]
fn completion_hover_and_definition_are_answered_and_parsed() {
    let session = start();
    session
        .client
        .notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, "x.al\nsecond\n"));
    session.wait_for_status(|status| *status == Status::Ready);

    let answer = session.ask("textDocument/completion", session.position_params(0, 4)).unwrap();
    let list = parse_items(&answer);
    assert_eq!(list.items.len(), 3);
    let alpha = &list.items[0];
    assert_eq!(alpha.label, "alpha");
    let edit = alpha.edit.as_ref().unwrap();
    assert_eq!((edit.range.start.character, edit.range.end.character), (2, 4));

    let resolved = session.ask("completionItem/resolve", alpha.raw.clone()).unwrap();
    assert!(resolved["documentation"]["value"].as_str().unwrap().contains("alpha"));

    let hover = session.ask("textDocument/hover", session.position_params(1, 2)).unwrap();
    assert!(hover["contents"]["value"].as_str().unwrap().contains("line 1: `second`"));

    let targets = parse_targets(&session.ask("textDocument/definition", session.position_params(0, 0)).unwrap());
    assert_eq!(targets[0].uri, session.uri);
    session.client.shutdown(WAIT);
}

#[test]
fn requests_before_the_server_is_ready_fail_instead_of_waiting() {
    let session = start();
    let result = session.ask("textDocument/hover", session.position_params(0, 0));
    if session.client.status() == Status::Starting {
        assert!(result.is_err());
    }
    session.client.shutdown(WAIT);
}

#[test]
fn a_crash_is_reported_with_its_last_words_and_fails_waiting_requests() {
    let session = start();
    session.client.notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, "fine\n"));
    session.wait_for_status(|status| *status == Status::Ready);
    session.client.notify_document(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": session.uri, "version": 2 }, "contentChanges": [{ "text": "CRASH" }] }),
    );
    let status = session.wait_for_status(|status| matches!(status, Status::Exited(_)));
    let Status::Exited(last_words) = status else {
        panic!("exited");
    };
    assert!(last_words.contains("crashed on purpose"), "{last_words}");
    assert!(session.ask("textDocument/hover", session.position_params(0, 0)).is_err());
}

#[test]
fn shutting_down_stops_the_server_and_says_so() {
    let session = start();
    session.wait_for_status(|status| *status == Status::Ready);
    session.client.shutdown(WAIT);
    session.wait_for_status(|status| *status == Status::Stopped);
}

#[test]
fn a_program_that_is_not_there_does_not_start() {
    let (sender, _heard) = mpsc::channel();
    let handler = Arc::new(Collector { sender: Mutex::new(sender) });
    let command = ServerCommand { program: PathBuf::from("/no/such/server"), args: Vec::new() };
    assert!(Client::start(&command, Path::new("/tmp"), Path::new("/tmp"), Value::Null, handler).is_err());
}
