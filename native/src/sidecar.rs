//! The sidecar: Grove's Node main process, run by Bun without Electron, and the relay
//! between it and the UI.
//!
//! The host spawns `bun src/main/sidecar/index.ts` at startup and passes its frames
//! through without interpreting requests. The frames are the ndjson `RpcMessage`s of
//! `sdk/src/frames.ts`, one JSON object per line on the child's stdin and stdout:
//!
//! - The UI hands each request frame to the `sidecar_send` command, which writes it to the
//!   child's stdin. The answer is not the command's result: it arrives as a frame.
//! - A reader thread parses each line the child prints. A `response`, `stream` or `end`
//!   frame is emitted whole as the `sidecar:reply` event, for the UI's client to match with
//!   its request. An `event` frame is emitted as `sidecar:event:<channel>` with just its
//!   payload, so the UI hears the channels it listens to and nothing else.
//! - When the child exits, `sidecar:exit` carries `{ code, message }`, and `sidecar_status`
//!   says the same to a UI that was not listening yet.
//!
//! The child leaves by itself when its stdin closes, which is also what happens if this
//! process dies, so it never outlives the app. `GROVE_SIDECAR` names another entry script,
//! or `off` to run without one; `GROVE_BUN` names another `bun`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands, Emitter};

/// How the sidecar is started.
pub struct SidecarConfig {
    bun: String,
    entry: PathBuf,
}

impl SidecarConfig {
    /// The configuration the environment asks for, or `None` when `GROVE_SIDECAR=off`.
    pub fn from_environment() -> Option<SidecarConfig> {
        let entry = std::env::var("GROVE_SIDECAR").unwrap_or_else(|_| default_entry().display().to_string());
        if entry == "off" || entry == "0" {
            return None;
        }
        let bun = std::env::var("GROVE_BUN").unwrap_or_else(|_| "bun".to_string());
        Some(SidecarConfig { bun, entry: PathBuf::from(entry) })
    }
}

/// The sidecar entry in the checkout this binary was built from.
fn default_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("src/main/sidecar/index.ts")
}

/// A running sidecar, or the lack of one; cheap to clone and share between commands.
#[derive(Clone)]
pub struct Sidecar {
    shared: Arc<Shared>,
}

struct Shared {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    status: Mutex<Value>,
}

impl Sidecar {
    /// Starts the sidecar and the thread that relays its output; a sidecar that cannot start
    /// is reported through the status, so the UI can say so.
    pub fn start(config: Option<SidecarConfig>, emitter: Emitter) -> Sidecar {
        let shared = Arc::new(Shared {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            status: Mutex::new(json!({ "state": "disabled" })),
        });
        if let Some(config) = config {
            spawn_child(&shared, &config, emitter);
        }
        Sidecar { shared }
    }

    /// Registers the commands the UI's sidecar client calls.
    pub fn commands(&self, commands: Commands) -> Commands {
        let sender = self.clone();
        let reporter = self.clone();
        commands
            .command("sidecar_send", move |frame| sender.send(&frame))
            .command("sidecar_status", move |_| Ok::<_, CommandError>(lock(&reporter.shared.status).clone()))
    }

    /// Writes one request frame to the child's stdin.
    fn send(&self, frame: &Value) -> Result<Value, CommandError> {
        let mut stdin = lock(&self.shared.stdin);
        let Some(stdin) = stdin.as_mut() else {
            return Err(CommandError::with_code("SidecarDown", "the sidecar is not running"));
        };
        let line = format!("{frame}\n");
        stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(|error| CommandError::with_code("SidecarDown", format!("could not reach the sidecar: {error}")))?;
        Ok(Value::Null)
    }

    /// Stops the child, which also makes it close the services it owns.
    pub fn stop(&self) {
        lock(&self.shared.stdin).take();
        if let Some(child) = lock(&self.shared.child).as_mut() {
            let _ = child.kill();
        }
    }
}

/// Locks a mutex, carrying on after a thread that held it panicked.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Spawns the child and starts reading it; any failure becomes the status.
fn spawn_child(shared: &Arc<Shared>, config: &SidecarConfig, emitter: Emitter) {
    let spawned = Command::new(&config.bun)
        .arg(&config.entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let message = format!("could not start {} {}: {error}", config.bun, config.entry.display());
            eprintln!("sidecar: {message}");
            *lock(&shared.status) = json!({ "state": "exited", "code": null, "message": message });
            return;
        }
    };
    let stdout = child.stdout.take().expect("stdout is piped");
    *lock(&shared.stdin) = child.stdin.take();
    *lock(&shared.status) = json!({ "state": "running", "pid": child.id() });
    *lock(&shared.child) = Some(child);
    let shared = shared.clone();
    std::thread::spawn(move || {
        relay_output(stdout, &emitter);
        report_exit(&shared, &emitter);
    });
}

/// Reads the child's frames until it closes its stdout, passing each on to the UI.
fn relay_output(stdout: impl std::io::Read, emitter: &Emitter) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match serde_json::from_str::<Value>(&line) {
            Ok(frame) => relay_frame(frame, emitter),
            Err(error) => eprintln!("sidecar: a line on stdout was not a frame ({error}): {line}"),
        }
    }
}

/// Emits one frame as the event the UI's client listens for.
fn relay_frame(mut frame: Value, emitter: &Emitter) {
    match frame["kind"].as_str() {
        Some("event") => {
            let Some(channel) = frame["channel"].as_str() else { return };
            let name = event_name(channel);
            emitter.emit(&name, frame["payload"].take());
        }
        Some("response" | "stream" | "end") => emitter.emit("sidecar:reply", frame),
        _ => {}
    }
}

/// The event a sidecar `channel` is emitted under.
fn event_name(channel: &str) -> String {
    format!("sidecar:event:{channel}")
}

/// Records how the child ended and tells the UI, so its pending calls can fail.
fn report_exit(shared: &Shared, emitter: &Emitter) {
    lock(&shared.stdin).take();
    let code = wait_for_exit(shared);
    let message = match code {
        Some(0) => "the sidecar exited".to_string(),
        Some(code) => format!("the sidecar exited with status {code}"),
        None => "the sidecar was stopped by a signal".to_string(),
    };
    eprintln!("sidecar: {message}");
    let status = json!({ "state": "exited", "code": code, "message": message });
    *lock(&shared.status) = status.clone();
    emitter.emit("sidecar:exit", status);
}

/// Waits for the child to end, without holding its lock so `stop` can still kill it.
fn wait_for_exit(shared: &Shared) -> Option<i32> {
    loop {
        let finished = match lock(&shared.child).as_mut() {
            Some(child) => child.try_wait(),
            None => return None,
        };
        match finished {
            Ok(Some(status)) => return status.code(),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}
