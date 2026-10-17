//! A language server process and the conversation with it.
//!
//! The server is a child process talking JSON-RPC over its stdin and stdout. Two threads serve
//! it: one writes the messages queued for it, one reads what it says. Requests are answered
//! through callbacks that run on the reading thread, so a callback does its work quickly or
//! hands it on. Notifications about documents sent before the server finished starting are held
//! and go out, in order, once it is ready.

use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::initialize::initialize_params;
use crate::protocol::{Capabilities, METHOD_NOT_FOUND, ResponseError};
use crate::rpc::{read_message, write_frame};

/// How often the process is looked at to see whether it is still there.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// How many of the server's last lines on stderr are kept, to say why it died.
const STDERR_LINES_KEPT: usize = 20;

/// How to start a server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// What a server is doing, as far as the editor can tell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Started, and answering the initialize request.
    Starting,
    /// Ready for documents and requests.
    Ready,
    /// Could not be started, or refused to initialize. Carries the reason.
    Failed(String),
    /// Ended without being asked to. Carries the end of what it wrote to stderr.
    Exited(String),
    /// Ended after being asked to.
    Stopped,
}

/// Who hears what a server says without being asked.
pub trait Handler: Send + Sync + 'static {
    /// A notification from the server, such as published diagnostics.
    fn notification(&self, method: &str, params: Value);
    /// A request from the server, which must be answered. Runs on the reading thread, so it
    /// answers without waiting for anything.
    fn request(&self, method: &str, params: Value) -> Result<Value, ResponseError>;
    /// The server's status changed.
    fn status(&self, status: &Status);
}

/// What runs when a request is answered.
pub type Callback = Box<dyn FnOnce(Result<Value, ResponseError>) + Send + 'static>;

/// Names a request that is waiting for its answer.
pub type RequestId = i64;

/// Everything a started server consists of. Shared by the client handle and the two threads.
struct Shared {
    /// Messages for the writing thread, gone once the server has ended.
    frames: Mutex<Option<Sender<Vec<u8>>>>,
    pending: Mutex<HashMap<RequestId, Callback>>,
    next_id: AtomicI64,
    state: Mutex<State>,
    child: Mutex<Option<Child>>,
    stderr_tail: Mutex<VecDeque<String>>,
    handler: Arc<dyn Handler>,
    /// Set once the end of the server has been handled, so the two ways of noticing it, its
    /// output closing and the process exiting, are not both acted on.
    ended: AtomicBool,
}

/// The server's status, what it can do, and the document messages waiting for it to be ready.
struct State {
    status: Status,
    capabilities: Option<Capabilities>,
    held: Vec<Vec<u8>>,
    shutting_down: bool,
}

/// A handle on a running server. Cheap to clone.
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
}

impl Client {
    /// Starts a server in `working_directory` and begins initializing it for the workspace at
    /// `root`. Returns at once; `Handler::status` hears when it is ready or has failed. An error
    /// here means the process could not be started at all.
    pub fn start(
        command: &ServerCommand,
        working_directory: &Path,
        root: &Path,
        initialization_options: Value,
        handler: Arc<dyn Handler>,
    ) -> io::Result<Client> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .current_dir(working_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| io::Error::other("the server has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("the server has no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| io::Error::other("the server has no stderr"))?;
        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        let shared = Arc::new(Shared {
            frames: Mutex::new(Some(sender)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            state: Mutex::new(State {
                status: Status::Starting,
                capabilities: None,
                held: Vec::new(),
                shutting_down: false,
            }),
            child: Mutex::new(Some(child)),
            stderr_tail: Mutex::new(VecDeque::new()),
            handler,
            ended: AtomicBool::new(false),
        });
        spawn_writer(stdin, receiver);
        spawn_stderr_reader(stderr, shared.clone());
        spawn_reader(stdout, shared.clone());
        spawn_exit_watcher(shared.clone());
        let client = Client { shared };
        client.shared.handler.status(&Status::Starting);
        client.send_initialize(root, initialization_options);
        Ok(client)
    }

    /// The server's status.
    pub fn status(&self) -> Status {
        lock(&self.shared.state).status.clone()
    }

    /// What the server can do, once it is ready.
    pub fn capabilities(&self) -> Option<Capabilities> {
        lock(&self.shared.state).capabilities.clone()
    }

    /// Sends a request. The callback runs with the answer, or with an error if the server ends
    /// first. Returns the id to cancel it by.
    pub fn request(&self, method: &str, params: Value, callback: Callback) -> RequestId {
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        if self.status() != Status::Ready && method != "initialize" {
            callback(Err(ResponseError::internal("the server is not ready")));
            return id;
        }
        self.send_request(id, method, params, callback);
        id
    }

    /// Sends a notification straight away.
    pub fn notify(&self, method: &str, params: Value) {
        self.send_json(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Sends a notification about a document: held until the server is ready, so it never sees
    /// one before it has initialized, and sent in the order it was made.
    pub fn notify_document(&self, method: &str, params: Value) {
        let body = serialize(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
        let mut state = lock(&self.shared.state);
        if state.status == Status::Starting {
            state.held.push(body);
            return;
        }
        if state.status == Status::Ready {
            self.send_body(body);
        }
    }

    /// Gives up on a request: the server is told, and the callback never runs.
    pub fn cancel(&self, id: RequestId) {
        let removed = lock(&self.shared.pending).remove(&id).is_some();
        if removed {
            self.notify("$/cancelRequest", json!({ "id": id }));
        }
    }

    /// Asks the server to shut down and waits up to `timeout` for it to, then ends the process
    /// if it has not. Does nothing for a server that has already ended.
    pub fn shutdown(&self, timeout: Duration) {
        let ready = {
            let mut state = lock(&self.shared.state);
            state.shutting_down = true;
            state.status == Status::Ready
        };
        if ready {
            let (sender, receiver) = mpsc::channel();
            let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
            let callback: Callback = Box::new(move |_| {
                let _ = sender.send(());
            });
            self.send_request(id, "shutdown", Value::Null, callback);
            let _ = receiver.recv_timeout(timeout);
            self.notify("exit", Value::Null);
            self.wait_for_exit(timeout);
        }
        self.kill();
    }

    /// Ends the process now.
    pub fn kill(&self) {
        let mut child = lock(&self.shared.child);
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Polls until the process has ended or `timeout` has passed.
    fn wait_for_exit(&self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let ended = match lock(&self.shared.child).as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            };
            if ended {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Sends the initialize request, and the initialized notification once it is answered.
    fn send_initialize(&self, root: &Path, initialization_options: Value) {
        let params = initialize_params(root, initialization_options);
        let client = self.clone();
        let callback: Callback = Box::new(move |result| client.finish_initializing(result));
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        self.send_request(id, "initialize", params, callback);
    }

    /// Takes the server's answer to initialize: it is ready, with the held messages sent, or failed.
    fn finish_initializing(&self, result: Result<Value, ResponseError>) {
        let answer = match result {
            Ok(answer) => answer,
            Err(error) => {
                self.set_status(Status::Failed(error.message));
                self.kill();
                return;
            }
        };
        let capabilities = Capabilities::from_json(&answer["capabilities"]);
        self.notify("initialized", json!({}));
        {
            // Sent under the lock, so a document notification made meanwhile cannot overtake them.
            let mut state = lock(&self.shared.state);
            state.capabilities = Some(capabilities);
            state.status = Status::Ready;
            for body in std::mem::take(&mut state.held) {
                self.send_body(body);
            }
        }
        self.shared.handler.status(&Status::Ready);
    }

    /// Registers the callback and sends the request.
    fn send_request(&self, id: RequestId, method: &str, params: Value, callback: Callback) {
        lock(&self.shared.pending).insert(id, callback);
        self.send_json(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    }

    /// Queues a message for the writing thread.
    fn send_json(&self, message: &Value) {
        self.send_body(serialize(message));
    }

    /// Queues an already serialized message. Dropped once the server has ended.
    fn send_body(&self, body: Vec<u8>) {
        if let Some(sender) = lock(&self.shared.frames).as_ref() {
            let _ = sender.send(body);
        }
    }

    /// Changes the status and tells the handler.
    fn set_status(&self, status: Status) {
        lock(&self.shared.state).status = status.clone();
        self.shared.handler.status(&status);
    }
}

/// Locks a mutex, carrying on after a thread that held it panicked.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A message as the bytes of its JSON.
fn serialize(message: &Value) -> Vec<u8> {
    serde_json::to_vec(message).unwrap_or_default()
}

/// Starts the thread that writes queued messages to the server's stdin.
fn spawn_writer(mut stdin: std::process::ChildStdin, receiver: mpsc::Receiver<Vec<u8>>) {
    let _ = thread::Builder::new().name("lsp-writer".into()).spawn(move || {
        while let Ok(body) = receiver.recv() {
            if write_frame(&mut stdin, &body).is_err() {
                return;
            }
        }
    });
}

/// Starts the thread that keeps the end of the server's stderr.
fn spawn_stderr_reader(stderr: std::process::ChildStderr, shared: Arc<Shared>) {
    let _ = thread::Builder::new().name("lsp-stderr".into()).spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = lock(&shared.stderr_tail);
            if tail.len() == STDERR_LINES_KEPT {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

/// Starts the thread that reads what the server says.
fn spawn_reader(stdout: ChildStdout, shared: Arc<Shared>) {
    let _ = thread::Builder::new().name("lsp-reader".into()).spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(message)) => dispatch(&shared, message),
                Ok(None) | Err(_) => break,
            }
        }
        server_ended(&shared);
    });
}

/// Starts the thread that notices the process exiting. A server whose helper processes inherited
/// its output keeps that open after it is gone, so waiting for the output to close is not enough.
fn spawn_exit_watcher(shared: Arc<Shared>) {
    let _ = thread::Builder::new().name("lsp-exit".into()).spawn(move || {
        loop {
            thread::sleep(EXIT_POLL_INTERVAL);
            if shared.ended.load(Ordering::SeqCst) {
                return;
            }
            let exited = match lock(&shared.child).as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            };
            if exited {
                server_ended(&shared);
                return;
            }
        }
    });
}

/// Routes a message from the server: an answer to its callback, a request to the handler, or a
/// notification to the handler.
fn dispatch(shared: &Arc<Shared>, message: Value) {
    let has_method = message.get("method").is_some();
    let has_id = message.get("id").is_some();
    if has_method && has_id {
        answer_server_request(shared, message);
        return;
    }
    if has_method {
        let method = message["method"].as_str().unwrap_or_default().to_string();
        shared.handler.notification(&method, message["params"].clone());
        return;
    }
    if has_id {
        deliver_response(shared, message);
    }
}

/// Runs the callback of the request a response answers.
fn deliver_response(shared: &Arc<Shared>, message: Value) {
    let Some(id) = message["id"].as_i64() else {
        return;
    };
    let Some(callback) = lock(&shared.pending).remove(&id) else {
        return;
    };
    if let Some(error) = message.get("error").filter(|error| !error.is_null()) {
        callback(Err(ResponseError::from_json(error)));
        return;
    }
    callback(Ok(message["result"].clone()));
}

/// Asks the handler to answer a request from the server, and sends the answer.
fn answer_server_request(shared: &Arc<Shared>, message: Value) {
    let method = message["method"].as_str().unwrap_or_default();
    let outcome = shared.handler.request(method, message["params"].clone());
    let response = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }),
        Err(error) => {
            let code = if error.code == 0 { METHOD_NOT_FOUND } else { error.code };
            json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": code, "message": error.message } })
        }
    };
    if let Some(sender) = lock(&shared.frames).as_ref() {
        let _ = sender.send(serialize(&response));
    }
}

/// The server's stdout closed: every request still waiting fails, and the status says whether
/// it was asked to go.
fn server_ended(shared: &Arc<Shared>) {
    if shared.ended.swap(true, Ordering::SeqCst) {
        return;
    }
    let waiting: Vec<Callback> = lock(&shared.pending).drain().map(|(_, callback)| callback).collect();
    for callback in waiting {
        callback(Err(ResponseError::internal("the server ended")));
    }
    *lock(&shared.frames) = None;
    if let Some(mut child) = lock(&shared.child).take() {
        let _ = child.wait();
    }
    // The stderr thread may still be draining the pipe.
    thread::sleep(Duration::from_millis(50));
    let status = {
        let mut state = lock(&shared.state);
        if matches!(state.status, Status::Failed(_)) {
            return;
        }
        let status = ended_status(state.shutting_down, &lock(&shared.stderr_tail));
        state.status = status.clone();
        status
    };
    shared.handler.status(&status);
}

/// The status of a server that has ended, given whether it was told to and what it last wrote.
fn ended_status(shutting_down: bool, stderr_tail: &VecDeque<String>) -> Status {
    if shutting_down {
        return Status::Stopped;
    }
    let tail: Vec<&str> = stderr_tail.iter().map(String::as_str).collect();
    Status::Exited(tail.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_that_was_not_asked_to_end_exited_with_its_last_words() {
        let tail: VecDeque<String> = ["one".to_string(), "two".to_string()].into();
        assert_eq!(ended_status(false, &tail), Status::Exited("one\ntwo".into()));
        assert_eq!(ended_status(true, &tail), Status::Stopped);
    }
}
