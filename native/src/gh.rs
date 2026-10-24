//! Runs the GitHub CLI for the GitHub pane, so the pane reads GitHub as the person who is logged in
//! to `gh`. The token never reaches the UI: it stays with `gh` (its keyring or `GH_TOKEN`), which
//! also resolves a folder's remote to a repository and pages through long answers.
//!
//! One command, `gh_run { args, cwd? }`, starts `gh` with `args`, in `cwd` when one is given, and
//! answers once it ends, with `{ "stdout": string, "error": null | { "kind": "missing" | "failed",
//! "message": string, "code": number | null } }`.
//!
//! - A `gh` that is not installed answers `error.kind == "missing"`, so the pane can say so.
//! - Any other failure answers `error.kind == "failed"` with what `gh` wrote to stderr as the
//!   message; the UI tells "not logged in" or "no remote" from the words.
//! - Prompts are switched off and the output has no colour, so a missing login ends the run
//!   instead of waiting for input that cannot come.

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// How much of `gh`'s stderr is kept to explain a failure.
const MAX_ERROR_CHARS: usize = 4096;

/// Registers the GitHub CLI command.
pub fn register(commands: Commands) -> Commands {
    commands.command("gh_run", |args| {
        let arguments = string_list(&args, "args");
        if arguments.is_empty() {
            return Err(CommandError::with_code("InvalidArguments", "gh_run needs args"));
        }
        let directory = args.get("cwd").and_then(Value::as_str).filter(|path| !path.is_empty()).map(Path::new);
        Ok(run(OsStr::new("gh"), &arguments, directory))
    })
}

/// Runs `program` with the arguments and answers as `gh_run` describes.
fn run(program: &OsStr, arguments: &[String], directory: Option<&Path>) -> Value {
    if let Some(directory) = directory {
        if !directory.is_dir() {
            return error_answer("failed", &format!("{} is not a directory", directory.display()), None);
        }
    }
    let mut command = Command::new(program);
    command.args(arguments).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1").env("GH_NO_UPDATE_NOTIFIER", "1");
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    let output = match command.output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return error_answer("missing", "the GitHub CLI (gh) is not installed or not on the PATH", None);
        }
        Err(error) => return error_answer("failed", &error.to_string(), None),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return json!({ "stdout": stdout, "error": Value::Null });
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut message = stderr.trim().chars().take(MAX_ERROR_CHARS).collect::<String>();
    if message.is_empty() {
        message = stdout.trim().chars().take(MAX_ERROR_CHARS).collect();
    }
    error_answer("failed", &message, output.status.code())
}

/// An answer that carries only an error.
fn error_answer(kind: &str, message: &str, code: Option<i32>) -> Value {
    json!({ "stdout": "", "error": { "kind": kind, "message": message, "code": code } })
}

/// A list-of-strings argument, empty when missing.
fn string_list(args: &Value, name: &str) -> Vec<String> {
    let Some(items) = args.get(name).and_then(Value::as_array) else {
        return Vec::new();
    };
    items.iter().filter_map(Value::as_str).map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arguments as owned strings.
    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn what_the_program_prints_is_the_answer() {
        let answer = run(OsStr::new("echo"), &strings(&["hello"]), None);
        assert_eq!(answer["stdout"], "hello\n");
        assert_eq!(answer["error"], Value::Null);
    }

    #[test]
    fn a_failing_run_carries_stderr_and_the_exit_code() {
        let script = strings(&["-c", "echo 'not logged in' >&2; exit 4"]);
        let answer = run(OsStr::new("sh"), &script, None);
        assert_eq!(answer["error"]["kind"], "failed");
        assert_eq!(answer["error"]["message"], "not logged in");
        assert_eq!(answer["error"]["code"], 4);
    }

    #[test]
    fn a_program_that_is_not_installed_is_missing() {
        let answer = run(OsStr::new("grove-test-no-such-program"), &strings(&["api"]), None);
        assert_eq!(answer["error"]["kind"], "missing");
    }

    #[test]
    fn a_directory_that_does_not_exist_fails_before_anything_runs() {
        let answer = run(OsStr::new("echo"), &strings(&["x"]), Some(Path::new("/no/such/directory")));
        assert_eq!(answer["error"]["kind"], "failed");
    }

    #[test]
    fn the_run_happens_in_the_directory() {
        let directory = std::env::temp_dir();
        let answer = run(OsStr::new("pwd"), &[], Some(&directory));
        let printed = answer["stdout"].as_str().unwrap().trim().to_string();
        assert_eq!(std::fs::canonicalize(printed).unwrap(), std::fs::canonicalize(directory).unwrap());
    }
}
