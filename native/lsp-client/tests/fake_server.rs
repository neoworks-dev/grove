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
use lsp_client::edits::{parse_prepare_rename, parse_text_edits, parse_workspace_edit, range_edits};
use lsp_client::protocol::{PublishDiagnostics, ResponseError, SyncKind, parse_targets};
use lsp_client::signature::{SignatureHelp, request_context};
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
            let items = params["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let answers = items.iter().map(|item| match item["section"].as_str() {
                Some("typescript") => {
                    lsp_client::config::section("typescript", "typescript", lsp_client::config::Switches { inlay_hints: false })
                }
                _ => json!({ "answered": true }),
            });
            return Ok(Value::Array(answers.collect()));
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
fn a_resolved_function_brings_its_documentation_and_its_call_parentheses() {
    let session = start();
    session
        .client
        .notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, "x.al\n"));
    session.wait_for_status(|status| *status == Status::Ready);
    // The server has the settings once it has said it was answered.
    session.wait_for(|heard| match heard {
        Heard::Notification(method, params) if method == "window/logMessage" => {
            params["message"].as_str().filter(|message| message.contains("answered")).map(str::to_string)
        }
        _ => None,
    });
    let answer = session.ask("textDocument/completion", session.position_params(0, 4)).unwrap();
    let mut alpha = parse_items(&answer).items.remove(0);
    assert!(alpha.documentation.is_none() && !alpha.is_snippet);

    alpha.merge_resolved(&session.ask("completionItem/resolve", alpha.raw.clone()).unwrap());
    assert_eq!(alpha.documentation.as_deref(), Some("docs for **alpha**"));
    assert!(alpha.is_snippet);
    assert_eq!(alpha.edit.as_ref().unwrap().new_text, "alpha(${1:value})$0");
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

/// Opens a document on the fake server and waits until it is ready.
fn open_document(session: &Session, text: &str) {
    session.client.notify_document("textDocument/didOpen", did_open_params(&session.uri, "typescript", 1, text));
    session.wait_for_status(|status| *status == Status::Ready);
}

#[test]
fn signature_help_follows_the_commas_and_names_the_parameter() {
    let session = start();
    open_document(&session, "alpha(1, \n");
    let capabilities = session.client.capabilities().unwrap();
    assert_eq!(capabilities.signature_trigger_characters, vec!["(", ","]);
    let params = json!({
        "textDocument": { "uri": session.uri }, "position": { "line": 0, "character": 9 },
        "context": request_context(Some(','), None),
    });
    let help = SignatureHelp::parse(&session.ask("textDocument/signatureHelp", params).unwrap()).unwrap();
    assert_eq!(help.signatures.len(), 2);
    let signature = help.signature(help.active_signature);
    let active = help.parameter_of(signature).unwrap();
    let range = signature.parameters[active].label_range.clone().unwrap();
    assert_eq!(&signature.label[range], "second: string");
    let closed = json!({ "textDocument": { "uri": session.uri }, "position": { "line": 0, "character": 7 } });
    assert!(session.ask("textDocument/signatureHelp", closed).is_ok());
    session.client.shutdown(WAIT);
}

#[test]
fn inlay_hints_are_requested_for_a_range_of_lines() {
    let session = start();
    let text = "let one = 1;\nlet two = 2;\nlet three = 3;\n";
    open_document(&session, text);
    let buffer = Buffer::from_text(text);
    let params = lsp_client::inlay::request_params(&session.uri, &buffer, 1, 2);
    let hints = lsp_client::inlay::parse_hints(&session.ask("textDocument/inlayHint", params).unwrap());
    assert_eq!(hints.len(), 2);
    assert_eq!((hints[0].position.line, hints[0].position.character, hints[0].text.as_str()), (1, 3, ": T"));
    session.client.shutdown(WAIT);
}

#[test]
fn references_and_highlights_find_every_whole_word() {
    let session = start();
    open_document(&session, "let total = 1;\ntotal += total2 + total;\n");
    let references = session.ask("textDocument/references", session.position_params(0, 5)).unwrap();
    let targets = parse_targets(&references);
    assert_eq!(targets.len(), 3);
    assert_eq!((targets[2].range.start.line, targets[2].range.start.character), (1, 18));
    let highlights = lsp_client::highlights::parse_ranges(
        &session.ask("textDocument/documentHighlight", session.position_params(1, 1)).unwrap(),
    );
    assert_eq!(highlights.len(), 3);
    assert!(parse_targets(&session.ask("textDocument/references", session.position_params(0, 11)).unwrap()).is_empty());
    session.client.shutdown(WAIT);
}

#[test]
fn rename_is_prepared_and_answers_with_edits_that_apply() {
    let session = start();
    let text = "let total = 1;\nconsole.log(total);\n";
    open_document(&session, text);
    let prepared =
        parse_prepare_rename(&session.ask("textDocument/prepareRename", session.position_params(0, 6)).unwrap())
            .unwrap();
    assert_eq!(prepared.placeholder.as_deref(), Some("total"));
    assert!(session.ask("textDocument/prepareRename", session.position_params(0, 11)).unwrap().is_null());
    let mut params = session.position_params(0, 6);
    params["newName"] = json!("sum");
    let edit = parse_workspace_edit(&session.ask("textDocument/rename", params).unwrap());
    assert_eq!(edit.files.len(), 1);
    let mut state = EditorState::new(Buffer::from_text(text));
    let edits = range_edits(state.buffer(), &edit.files[0].edits);
    state.apply(&Command::ApplyEdits { edits });
    assert_eq!(state.buffer().slice(0..state.buffer().length()), "let sum = 1;\nconsole.log(sum);\n");
    session.client.shutdown(WAIT);
}

#[test]
fn code_actions_offer_a_fix_for_each_diagnostic_and_a_refactor() {
    let session = start();
    open_document(&session, "x BAD\n");
    let published = session.next_diagnostics();
    let range = json!({ "start": { "line": 0, "character": 2 }, "end": { "line": 0, "character": 2 } });
    let params = lsp_client::actions::request_params(&session.uri, range, &published.diagnostics);
    let mut actions = lsp_client::actions::parse_actions(&session.ask("textDocument/codeAction", params).unwrap());
    lsp_client::actions::order_for_menu(&mut actions);
    assert_eq!(actions.len(), 2);
    assert!(actions[0].is_quick_fix() && actions[0].is_preferred);
    assert_eq!(actions[0].edit.as_ref().unwrap().edit_count(), 1);
    assert_eq!(actions[1].command.as_ref().unwrap()["command"], "fake.extract");
    session.client.shutdown(WAIT);
}

#[test]
fn formatting_edits_strip_trailing_white_space_and_type_definitions_are_found() {
    let session = start();
    let text = "let a = 1;   \nlet b = 2;\nlet c = 3; \n";
    open_document(&session, text);
    let params = json!({ "textDocument": { "uri": session.uri }, "options": { "tabSize": 4, "insertSpaces": true } });
    let edits = parse_text_edits(&session.ask("textDocument/formatting", params).unwrap());
    assert_eq!(edits.len(), 2);
    let mut state = EditorState::new(Buffer::from_text(text));
    let converted = range_edits(state.buffer(), &edits);
    state.apply(&Command::ApplyEdits { edits: converted });
    assert_eq!(state.buffer().slice(0..state.buffer().length()), "let a = 1;\nlet b = 2;\nlet c = 3;\n");
    let capabilities = session.client.capabilities().unwrap();
    assert!(capabilities.type_definition && capabilities.implementation && capabilities.formatting);
    let targets = parse_targets(&session.ask("textDocument/typeDefinition", session.position_params(0, 4)).unwrap());
    assert_eq!(targets[0].range.start.line, 1);
    session.client.shutdown(WAIT);
}
