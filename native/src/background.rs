//! Stops the background commands an agent started.
//!
//! Claude Code runs each background command in a process group of its own and writes its output to
//! a file. One command, `background_stop { path }`, finds the processes whose stdout or stderr is
//! that file in `/proc` and sends SIGTERM to their process groups. It answers with
//! `{ "stopped": <groups signalled> }`, and rejects with `NothingToStop` when no process writes the
//! file, which is how a command that already ended looks. The agent's own output file then ends
//! with the exit code, which the app reads.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// Registers the `background_stop` command.
pub fn register(commands: Commands) -> Commands {
    commands.command("background_stop", |args| {
        let path = match args.get("path").and_then(Value::as_str) {
            Some(path) => path.to_string(),
            None => return Err(CommandError::with_code("InvalidArguments", "background_stop needs a string path")),
        };
        let groups = writer_groups(Path::new(&path));
        if groups.is_empty() {
            return Err(CommandError::with_code("NothingToStop", "no process writes its output"));
        }
        for group in &groups {
            let signalled = Command::new("kill").args(["-TERM", "--", &format!("-{group}")]).status();
            if let Err(error) = signalled {
                return Err(CommandError::with_code("Other", format!("kill: {error}")));
            }
        }
        Ok(json!({ "stopped": groups.len() }))
    })
}

/// The process groups of the processes whose stdout or stderr is `path`, never this app's own.
fn writer_groups(path: &Path) -> Vec<i64> {
    let entries = match std::fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let own = process_group("self");
    let mut groups = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = match name.to_str() {
            Some(pid) if pid.bytes().all(|byte| byte.is_ascii_digit()) => pid.to_string(),
            _ => continue,
        };
        let writes = ["1", "2"]
            .iter()
            .any(|descriptor| std::fs::read_link(format!("/proc/{pid}/fd/{descriptor}")).is_ok_and(|target| target == path));
        if !writes {
            continue;
        }
        match process_group(&pid) {
            Some(group) if group > 1 && Some(group) != own && !groups.contains(&group) => groups.push(group),
            _ => {}
        }
    }
    groups
}

/// The process group of `pid` (or `"self"`), from the fifth field of its `stat` after the command name.
fn process_group(pid: &str) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_command = stat.rsplit_once(')')?.1;
    after_command.split_whitespace().nth(2)?.parse().ok()
}
