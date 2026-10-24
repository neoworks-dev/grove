//! The tools Grove offers the suite daemon: a small MCP server (Streamable HTTP, JSON replies) on
//! the loopback address, which the daemon's gateway connects to through the `mcp` endpoint of
//! Grove's presence. The suite's own tool server needs Node's `http`, which the UI's JavaScript
//! runtime does not have, so the host listens and the UI answers.
//!
//! - `tools_start` starts listening, once, and returns `{ url, headers }` for the presence.
//! - `tools_set { tools }` replaces the tools listed (`name`, `description`, `inputSchema`) and
//!   returns the endpoint again. The URL carries a version that changes with the list, so the
//!   gateway, which compares endpoints, connects again and lists the tools afresh.
//! - A call from the gateway is emitted to the UI as the event `tool-call`
//!   `{ id, name, arguments }`, and the UI answers with `tools_result { id, text, isError? }`.
//!
//! The server answers only requests that carry the bearer token it handed out, and keeps no
//! sessions: every request stands alone.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

/// How long a call waits for the UI to answer.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// How long an idle connection is kept open.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// The largest request body accepted.
const MAX_BODY: usize = 1 << 20;

/// What the UI answered to a tool call.
struct Outcome {
    text: String,
    is_error: bool,
}

/// Runs a tool call somewhere and waits for its outcome, or fails with why it could not be run.
type Caller = dyn Fn(&str, &Value) -> Result<Outcome, String> + Send + Sync;

/// Registers the tool commands.
pub fn register(commands: Commands) -> Commands {
    let pending = Pending::default();
    let server = Arc::new(Mutex::new(None::<Arc<Server>>));
    let emitter = commands.emitter();
    let start_pending = pending.clone();
    let start_server = server.clone();
    let set_server = server.clone();
    commands
        .command("tools_start", move |_| {
            let mut slot = start_server.lock();
            if slot.is_none() {
                let caller = ui_caller(emitter.clone(), start_pending.clone());
                *slot = Some(Server::start(Box::new(caller)).map_err(CommandError::from)?);
            }
            Ok::<_, CommandError>(slot.as_ref().expect("just started").endpoint())
        })
        .command("tools_set", move |args| {
            let Some(server) = set_server.lock().clone() else {
                return Err(CommandError::from("tools_start has to come first"));
            };
            server.set_tools(args["tools"].as_array().cloned().unwrap_or_default());
            Ok(server.endpoint())
        })
        .command("tools_result", move |args| {
            let id = args["id"].as_u64().ok_or("tools_result needs the id of the call")?;
            let outcome = Outcome {
                text: args["text"].as_str().unwrap_or("").to_string(),
                is_error: args["isError"].as_bool().unwrap_or(false),
            };
            pending.answer(id, outcome);
            Ok::<_, CommandError>(Value::Null)
        })
}

/// The calls that wait for the UI, by id.
#[derive(Clone, Default)]
struct Pending {
    waiting: Arc<Mutex<HashMap<u64, Sender<Outcome>>>>,
    next: Arc<Mutex<u64>>,
}

impl Pending {
    /// Starts a call: its id, and the receiver its outcome arrives on.
    fn begin(&self) -> (u64, std::sync::mpsc::Receiver<Outcome>) {
        let mut next = self.next.lock();
        *next += 1;
        let (sender, receiver) = channel();
        self.waiting.lock().insert(*next, sender);
        (*next, receiver)
    }

    /// Hands the UI's answer to the call waiting for it, if it still waits.
    fn answer(&self, id: u64, outcome: Outcome) {
        if let Some(sender) = self.waiting.lock().remove(&id) {
            let _ = sender.send(outcome);
        }
    }

    /// Forgets a call that nobody waits for any more.
    fn forget(&self, id: u64) {
        self.waiting.lock().remove(&id);
    }
}

/// The caller that hands a call to the UI as an event and waits for `tools_result`.
fn ui_caller(emitter: Emitter, pending: Pending) -> impl Fn(&str, &Value) -> Result<Outcome, String> + Send + Sync {
    move |name, arguments| {
        if !emitter.has_listeners("tool-call") {
            return Err("Grove's window is not listening for tool calls".to_string());
        }
        let (id, receiver) = pending.begin();
        emitter.emit("tool-call", json!({ "id": id, "name": name, "arguments": arguments }));
        match receiver.recv_timeout(CALL_TIMEOUT) {
            Ok(outcome) => Ok(outcome),
            Err(_) => {
                pending.forget(id);
                Err(format!("{name} did not answer in {} seconds", CALL_TIMEOUT.as_secs()))
            }
        }
    }
}

/// The listening server: its address, token and the tools it lists.
struct Server {
    port: u16,
    token: String,
    tools: Mutex<Vec<Value>>,
    version: Mutex<u64>,
    caller: Box<Caller>,
}

impl Server {
    /// Binds a free loopback port and serves it on a thread of its own.
    fn start(caller: Box<Caller>) -> Result<Arc<Server>, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("could not listen: {error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let server = Arc::new(Server {
            port,
            token: new_token()?,
            tools: Mutex::new(Vec::new()),
            version: Mutex::new(1),
            caller,
        });
        let accepting = server.clone();
        std::thread::Builder::new()
            .name("tools-accept".to_string())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let connection = accepting.clone();
                    let _ = std::thread::Builder::new()
                        .name("tools-connection".to_string())
                        .spawn(move || connection.serve(stream));
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(server)
    }

    /// `{ url, headers }`, as the presence's `mcp` wants it.
    fn endpoint(&self) -> Value {
        let version = *self.version.lock();
        json!({
            "url": format!("http://127.0.0.1:{}/mcp?v={version}", self.port),
            "headers": { "Authorization": format!("Bearer {}", self.token) },
        })
    }

    /// Replaces the listed tools, and bumps the version when they differ.
    fn set_tools(&self, tools: Vec<Value>) {
        let mut listed = self.tools.lock();
        if *listed == tools {
            return;
        }
        *listed = tools;
        *self.version.lock() += 1;
    }

    /// Answers the requests of one connection until it closes or idles out.
    fn serve(&self, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(IDLE_TIMEOUT));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        while let Some(request) = read_request(&mut reader) {
            let reply = self.reply(&request);
            if writer.write_all(&reply).is_err() || request.close {
                return;
            }
        }
    }

    /// The raw HTTP reply to one request.
    fn reply(&self, request: &Request) -> Vec<u8> {
        if request.path != "/mcp" {
            return http(404, "text/plain", "not found");
        }
        if request.authorization != format!("Bearer {}", self.token) {
            return http(401, "text/plain", "unauthorized");
        }
        if request.method != "POST" {
            return http(405, "text/plain", "this server answers POST only");
        }
        let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
            return http(400, "application/json", &rpc_error(Value::Null, -32700, "parse error").to_string());
        };
        let answers = match message {
            Value::Array(batch) => batch.iter().filter_map(|single| self.answer(single)).collect::<Vec<_>>(),
            single => self.answer(&single).into_iter().collect(),
        };
        if answers.is_empty() {
            return http(202, "text/plain", "");
        }
        let body = if answers.len() == 1 { answers[0].clone() } else { Value::Array(answers) };
        http(200, "application/json", &body.to_string())
    }

    /// The JSON-RPC answer to one message, or none for a notification.
    fn answer(&self, message: &Value) -> Option<Value> {
        let id = message.get("id")?.clone();
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        match method {
            "initialize" => Some(rpc_result(id, self.initialize(params))),
            "ping" => Some(rpc_result(id, json!({}))),
            "tools/list" => Some(rpc_result(id, json!({ "tools": *self.tools.lock() }))),
            "tools/call" => Some(self.call(id, params)),
            _ => Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
        }
    }

    /// What `initialize` answers: the protocol version the client asked for, and the tools capability.
    fn initialize(&self, params: &Value) -> Value {
        let version = params["protocolVersion"].as_str().unwrap_or("2025-03-26");
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "grove", "version": env!("CARGO_PKG_VERSION") },
        })
    }

    /// Runs a `tools/call` through the caller. A tool that failed, or could not be run, is a result with `isError`.
    fn call(&self, id: Value, params: &Value) -> Value {
        let name = params["name"].as_str().unwrap_or("");
        let listed = self.tools.lock().iter().any(|tool| tool["name"] == name);
        if !listed {
            return rpc_error(id, -32602, &format!("no tool {name}"));
        }
        let outcome = (self.caller)(name, &params["arguments"]);
        let (text, is_error) = match outcome {
            Ok(outcome) => (outcome.text, outcome.is_error),
            Err(reason) => (reason, true),
        };
        rpc_result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
    }
}

/// A JSON-RPC success.
fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// A JSON-RPC failure.
fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Thirty-two random bytes as hex, from the system's source.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    let mut source = std::fs::File::open("/dev/urandom").map_err(|error| format!("no random source: {error}"))?;
    source.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// One HTTP request, as far as the server reads it.
struct Request {
    method: String,
    path: String,
    authorization: String,
    body: Vec<u8>,
    /// Whether the client asked to close the connection after the reply.
    close: bool,
}

/// Reads one request from the connection, or none when it closed, idled out or sent something unreadable.
fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?;
    let path = target.split('?').next().unwrap_or("").to_string();
    let mut authorization = String::new();
    let mut length = 0usize;
    let mut close = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "authorization" => authorization = value.to_string(),
            "content-length" => length = value.parse().ok()?,
            "connection" => close = value.eq_ignore_ascii_case("close"),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request { method, path, authorization, body, close })
}

/// A complete HTTP/1.1 reply.
fn http(status: u16, content_type: &str, body: &str) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server whose tools run `caller`, listing one tool called `openFile`.
    fn server_with(caller: impl Fn(&str, &Value) -> Result<Outcome, String> + Send + Sync + 'static) -> Arc<Server> {
        let server = Server::start(Box::new(caller)).unwrap();
        server.set_tools(vec![
            json!({ "name": "openFile", "description": "Opens a file", "inputSchema": {"type": "object"} }),
        ]);
        server
    }

    /// Posts a JSON-RPC message with the given authorization and returns the status line and the body.
    fn post(server: &Server, authorization: &str, message: Value) -> (String, String) {
        let body = message.to_string();
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        let request = format!(
            "POST /mcp?v=1 HTTP/1.1\r\nHost: x\r\nAuthorization: {authorization}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        let (head, body) = reply.split_once("\r\n\r\n").unwrap();
        (head.lines().next().unwrap().to_string(), body.to_string())
    }

    fn bearer(server: &Server) -> String {
        format!("Bearer {}", server.token)
    }

    #[test]
    fn requests_without_the_token_are_refused() {
        let server = server_with(|_, _| Err("never".into()));
        let (status, _) = post(&server, "Bearer wrong", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
        assert!(status.contains("401"), "{status}");
    }

    #[test]
    fn initialize_and_list_answer_as_an_mcp_server() {
        let server = server_with(|_, _| Err("never".into()));
        let (_, body) = post(
            &server,
            &bearer(&server),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
        );
        let answer: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert!(answer["result"]["capabilities"]["tools"].is_object());
        let (_, body) = post(&server, &bearer(&server), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let answer: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(answer["result"]["tools"][0]["name"], "openFile");
    }

    #[test]
    fn a_notification_is_accepted_without_a_body() {
        let server = server_with(|_, _| Err("never".into()));
        let (status, body) =
            post(&server, &bearer(&server), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        assert!(status.contains("202"), "{status}");
        assert_eq!(body, "");
    }

    #[test]
    fn a_call_reaches_the_caller_and_its_text_comes_back() {
        let server = server_with(|name, arguments| {
            Ok(Outcome { text: format!("{name} {}", arguments["path"]), is_error: false })
        });
        let (_, body) = post(
            &server,
            &bearer(&server),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "openFile", "arguments": { "path": "a.rs" } } }),
        );
        let answer: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(answer["result"]["content"][0]["text"], "openFile \"a.rs\"");
        assert_eq!(answer["result"]["isError"], false);
    }

    #[test]
    fn a_call_that_could_not_run_is_an_error_result_and_an_unlisted_tool_is_refused() {
        let server = server_with(|_, _| Err("window gone".into()));
        let call = |name: &str| json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": name, "arguments": {} } });
        let (_, body) = post(&server, &bearer(&server), call("openFile"));
        let answer: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], "window gone");
        let (_, body) = post(&server, &bearer(&server), call("nothing"));
        let answer: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(answer["error"]["code"], -32602);
    }

    #[test]
    fn the_endpoint_version_changes_with_the_tools() {
        let server = server_with(|_, _| Err("never".into()));
        let before = server.endpoint()["url"].clone();
        let same = server.tools.lock().clone();
        server.set_tools(same);
        assert_eq!(server.endpoint()["url"], before);
        server.set_tools(Vec::new());
        assert_ne!(server.endpoint()["url"], before);
    }

    #[test]
    fn pending_calls_get_their_answer_by_id() {
        let pending = Pending::default();
        let (id, receiver) = pending.begin();
        pending.answer(id, Outcome { text: "done".into(), is_error: false });
        assert_eq!(receiver.recv().unwrap().text, "done");
        let (second, _) = pending.begin();
        assert_ne!(id, second);
    }
}
