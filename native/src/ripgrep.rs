//! Runs ripgrep for the file picker and the content search, and stops the run they replace.
//!
//! One command, `ripgrep_run { key, cwd, args, limit, count }`, starts `rg` with `args` in `cwd`
//! and answers once it ends, with what it printed as `{ "lines": [...], "truncated": bool,
//! "error": null | { "kind": "missing" | "failed", "message" } }`.
//!
//! - **`key`** names the caller. Starting a run with a key that already has one running kills the
//!   old `rg` first, so typing faster than ripgrep answers never piles processes up. The killed
//!   run answers with `"cancelled": true` and whatever it had printed; the caller ignores it.
//! - **`limit`** caps the output. Past it `rg` is killed and `truncated` is true, so a query that
//!   matches everything costs no more than one that matches a little.
//! - **`count`** says what the limit counts: `"lines"` (every line of output, for `rg --files`) or
//!   `"matches"` (only the `match` events of `rg --json`, since each file also prints begin and end
//!   events that should not use up the limit).
//! - A ripgrep that is not installed answers `error.kind == "missing"`, so the UI can say so.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// The prefix of a `rg --json` line that reports a match.
const MATCH_EVENT_PREFIX: &str = "{\"type\":\"match\"";

/// How much of ripgrep's stderr is kept to explain a failure.
const MAX_ERROR_BYTES: u64 = 4096;

/// What a run's limit counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Counting {
    Lines,
    Matches,
}

/// A run of `rg` that can be killed from another thread.
struct Run {
    id: u64,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

/// The runs in progress, one per key.
#[derive(Clone, Default)]
struct Runs {
    running: Arc<Mutex<HashMap<String, Run>>>,
    next_id: Arc<AtomicU64>,
}

/// Registers the ripgrep command.
pub fn register(commands: Commands) -> Commands {
    let runs = Runs::default();
    commands.command("ripgrep_run", move |args| runs.run(&args))
}

impl Runs {
    /// Runs `rg` as the arguments ask and answers with what it printed.
    fn run(&self, args: &Value) -> Result<Value, CommandError> {
        let key = string_argument(args, "key")?;
        let directory = string_argument(args, "cwd")?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(1000) as usize;
        let counting = counting_of(args);
        if !std::path::Path::new(&directory).is_dir() {
            return Ok(error_answer("failed", &format!("{directory} is not a directory")));
        }
        let mut command = Command::new("rg");
        command.args(string_list(args, "args")).current_dir(&directory);
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(error_answer("missing", "ripgrep (rg) is not installed or not on the PATH"));
            }
            Err(error) => return Ok(error_answer("failed", &error.to_string())),
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let run = self.start(&key, child);
        let errors = std::thread::spawn(move || read_errors(stderr));
        let mut collected = Collected::default();
        if let Some(stdout) = stdout {
            collected = read_output(stdout, limit, counting, &run);
        }
        let status = finish(&run);
        let message = errors.join().unwrap_or_default();
        self.finished(&key, run.id);
        Ok(answer(&collected, status, &message, run.cancelled.load(Ordering::SeqCst)))
    }

    /// Registers a started child under `key`, killing the run it replaces.
    fn start(&self, key: &str, child: Child) -> Run {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let run = Run { id, child: Arc::new(Mutex::new(child)), cancelled: Arc::new(AtomicBool::new(false)) };
        let handle = Run { id, child: run.child.clone(), cancelled: run.cancelled.clone() };
        let replaced = lock(&self.running).insert(key.to_string(), handle);
        if let Some(old) = replaced {
            old.cancelled.store(true, Ordering::SeqCst);
            let _ = lock(&old.child).kill();
        }
        run
    }

    /// Forgets a run that ended, unless a newer one has taken its key.
    fn finished(&self, key: &str, id: u64) {
        let mut running = lock(&self.running);
        let is_current = running.get(key).is_some_and(|run| run.id == id);
        if is_current {
            running.remove(key);
        }
    }
}

/// What a run printed before it ended or hit its limit.
#[derive(Default)]
struct Collected {
    lines: Vec<String>,
    truncated: bool,
}

/// Reads ripgrep's output line by line until it ends or the limit is reached, killing it then.
fn read_output(stdout: impl Read, limit: usize, counting: Counting, run: &Run) -> Collected {
    let mut collected = Collected::default();
    let mut counted = 0;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            continue;
        }
        if counts_toward_limit(&line, counting) {
            counted += 1;
        }
        collected.lines.push(line);
        if counted >= limit {
            collected.truncated = true;
            let _ = lock(&run.child).kill();
            break;
        }
    }
    collected
}

/// Whether a line of output uses up the run's limit.
fn counts_toward_limit(line: &str, counting: Counting) -> bool {
    match counting {
        Counting::Lines => true,
        Counting::Matches => line.starts_with(MATCH_EVENT_PREFIX),
    }
}

/// The text ripgrep wrote to stderr, trimmed and capped.
fn read_errors(stderr: Option<impl Read>) -> String {
    let Some(stderr) = stderr else {
        return String::new();
    };
    let mut text = String::new();
    let _ = stderr.take(MAX_ERROR_BYTES).read_to_string(&mut text);
    text.trim().to_string()
}

/// Waits for the child to end and gives its exit code, or none when a signal ended it.
fn finish(run: &Run) -> Option<i32> {
    let mut child = lock(&run.child);
    child.wait().ok().and_then(|status| status.code())
}

/// The command's answer for a run that ended with `status`.
fn answer(collected: &Collected, status: Option<i32>, message: &str, cancelled: bool) -> Value {
    // Exit code 2 with output is a partial failure, such as one unreadable file; without output it
    // is a real one, such as a bad flag, and the message says why.
    let failed = status == Some(2) && collected.lines.is_empty() && !collected.truncated;
    let mut error = Value::Null;
    if failed && !cancelled {
        error = json!({ "kind": "failed", "message": message });
    }
    json!({ "lines": collected.lines, "truncated": collected.truncated, "cancelled": cancelled, "error": error })
}

/// An answer that carries only an error.
fn error_answer(kind: &str, message: &str) -> Value {
    json!({ "lines": [], "truncated": false, "cancelled": false, "error": { "kind": kind, "message": message } })
}

/// A string argument of the command.
fn string_argument(args: &Value, name: &str) -> Result<String, CommandError> {
    match args.get(name).and_then(Value::as_str) {
        Some(value) => Ok(value.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", format!("ripgrep_run needs a string {name}"))),
    }
}

/// A list-of-strings argument, empty when missing.
fn string_list(args: &Value, name: &str) -> Vec<String> {
    let Some(items) = args.get(name).and_then(Value::as_array) else {
        return Vec::new();
    };
    items.iter().filter_map(Value::as_str).map(str::to_string).collect()
}

/// What the `count` argument asks the limit to count.
fn counting_of(args: &Value) -> Counting {
    match args.get("count").and_then(Value::as_str) {
        Some("matches") => Counting::Matches,
        _ => Counting::Lines,
    }
}

/// Locks a mutex, carrying on after a thread that panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `rg` with these arguments in `directory`.
    fn run_in(runs: &Runs, key: &str, directory: &std::path::Path, args: &[&str], count: &str, limit: u64) -> Value {
        runs.run(&json!({ "key": key, "cwd": directory.display().to_string(), "args": args, "count": count, "limit": limit }))
            .unwrap()
    }

    /// A directory with a few files, one of them ignored.
    fn project(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-native-rg-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(directory.join("a.txt"), "one\ntwo needle\nthree needle\n").unwrap();
        std::fs::write(directory.join("b.txt"), "needle\n").unwrap();
        std::fs::write(directory.join("ignored.txt"), "needle\n").unwrap();
        directory
    }

    #[test]
    fn files_are_listed_and_the_limit_truncates() {
        let directory = project("files");
        let runs = Runs::default();
        let all = run_in(&runs, "files", &directory, &["--files", "--sort", "path", "--no-require-git"], "lines", 100);
        assert_eq!(all["lines"], json!(["a.txt", "b.txt"]));
        assert_eq!(all["truncated"], false);
        let capped = run_in(&runs, "files", &directory, &["--files", "--sort", "path", "--no-require-git"], "lines", 1);
        assert_eq!(capped["lines"], json!(["a.txt"]));
        assert_eq!(capped["truncated"], true);
    }

    #[test]
    fn json_runs_count_only_matches_toward_the_limit() {
        let directory = project("json");
        let runs = Runs::default();
        let answer = run_in(
            &runs,
            "grep",
            &directory,
            &["--json", "--sort", "path", "--no-require-git", "needle"],
            "matches",
            2,
        );
        let lines = answer["lines"].as_array().unwrap();
        let matches = lines.iter().filter(|line| line.as_str().unwrap().starts_with(MATCH_EVENT_PREFIX)).count();
        assert_eq!(matches, 2);
        assert_eq!(answer["truncated"], true);
    }

    #[test]
    fn a_failing_run_reports_why() {
        let directory = project("failing");
        let runs = Runs::default();
        let answer = run_in(&runs, "grep", &directory, &["--no-such-flag"], "lines", 10);
        assert_eq!(answer["error"]["kind"], "failed");
        assert!(!answer["error"]["message"].as_str().unwrap().is_empty());
    }

    #[test]
    fn a_new_run_with_the_same_key_kills_the_old_one() {
        let directory = project("replace");
        let runs = Runs::default();
        // A process that outlasts the test stands in for a slow search.
        let mut waiting = Command::new("sleep");
        waiting.arg("30").stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = waiting.spawn().unwrap();
        let first = runs.start("grep", child);
        let second = run_in(&runs, "grep", &directory, &["--files", "--no-require-git"], "lines", 10);
        assert_eq!(second["cancelled"], false);
        assert!(first.cancelled.load(Ordering::SeqCst));
        assert!(finish(&first).is_none());
    }
}
