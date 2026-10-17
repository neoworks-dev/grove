//! What the git-gutter plugin asks git: how a file differs from `HEAD`, and who last touched a
//! line. Both run `git` in the file's own directory, so they work for any file in any repository
//! without the UI knowing which one, and answer with plain data for the plugin to turn into
//! decorations.
//!
//! Commands:
//!
//! - `git_file_changes { path }` answers `{ "state": "clean" | "changed" | "untracked" | "outside",
//!   "hunks": [{ "oldStart", "oldCount", "newStart", "newCount" }] }`, with lines counted from 1.
//!   A file outside any repository is `outside`, and a file git does not track is `untracked`,
//!   whose lines are all new.
//! - `git_blame_line { path, line }` answers the commit that last changed a line (counted from 1)
//!   as `{ "hash", "author", "time", "summary", "committed" }`, or null when git has none to name.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

/// A changed stretch of a file, as a `@@ -a,b +c,d @@` header of a zero-context diff gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Hunk {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
}

/// Registers the git commands.
pub fn register(commands: Commands) -> Commands {
    commands
        .command("git_file_changes", |args| {
            let path = path_argument(&args)?;
            Ok::<_, CommandError>(file_changes(Path::new(&path)))
        })
        .command("git_blame_line", |args| {
            let path = path_argument(&args)?;
            let line = args.get("line").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok::<_, CommandError>(blame_line(Path::new(&path), line))
        })
}

/// The `path` argument of a command.
fn path_argument(args: &Value) -> Result<String, CommandError> {
    match args.get("path").and_then(Value::as_str) {
        Some(path) => Ok(path.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", "this command takes a string path")),
    }
}

/// How a file differs from `HEAD`, in the form `git_file_changes` answers.
fn file_changes(path: &Path) -> Value {
    let Some(directory) = path.parent() else {
        return changes_json("outside", &[]);
    };
    if run_git(directory, &["rev-parse", "--is-inside-work-tree"]).is_none() {
        return changes_json("outside", &[]);
    }
    let file = path.display().to_string();
    if run_git(directory, &["ls-files", "--error-unmatch", "--", &file]).is_none() {
        return changes_json("untracked", &[]);
    }
    let Some(diff) = run_git(directory, &["diff", "-U0", "--no-color", "--no-ext-diff", "HEAD", "--", &file]) else {
        return changes_json("untracked", &[]);
    };
    let hunks = parse_hunks(&diff);
    if hunks.is_empty() {
        return changes_json("clean", &hunks);
    }
    changes_json("changed", &hunks)
}

/// The answer of `git_file_changes`.
fn changes_json(state: &str, hunks: &[Hunk]) -> Value {
    let hunks: Vec<Value> = hunks
        .iter()
        .map(|hunk| {
            json!({
                "oldStart": hunk.old_start,
                "oldCount": hunk.old_count,
                "newStart": hunk.new_start,
                "newCount": hunk.new_count,
            })
        })
        .collect();
    json!({ "state": state, "hunks": hunks })
}

/// The hunks in a unified diff, from their `@@` headers.
fn parse_hunks(diff: &str) -> Vec<Hunk> {
    diff.lines().filter_map(|line| parse_hunk_header(line.strip_prefix("@@ -")?)).collect()
}

/// A hunk from a header without its leading `@@ -`, such as `3,2 +3,4 @@ fn main`. A missing count is 1.
fn parse_hunk_header(header: &str) -> Option<Hunk> {
    let (old, rest) = header.split_once(" +")?;
    let (new, _) = rest.split_once(' ')?;
    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;
    Some(Hunk { old_start, old_count, new_start, new_count })
}

/// A `start` or `start,count` range of a hunk header.
fn parse_range(range: &str) -> Option<(usize, usize)> {
    let Some((start, count)) = range.split_once(',') else {
        return Some((range.parse().ok()?, 1));
    };
    Some((start.parse().ok()?, count.parse().ok()?))
}

/// The commit that last changed a line, in the form `git_blame_line` answers.
fn blame_line(path: &Path, line: usize) -> Value {
    let Some(directory) = path.parent() else {
        return Value::Null;
    };
    if line == 0 {
        return Value::Null;
    }
    let range = format!("{line},{line}");
    let file = path.display().to_string();
    let Some(output) = run_git(directory, &["blame", "--porcelain", "-L", &range, "--", &file]) else {
        return Value::Null;
    };
    parse_blame(&output)
}

/// The commit in the porcelain blame of one line.
fn parse_blame(output: &str) -> Value {
    let mut lines = output.lines();
    let Some(hash) = lines.next().and_then(|first| first.split(' ').next()) else {
        return Value::Null;
    };
    let mut author = "";
    let mut time = 0u64;
    let mut summary = "";
    for line in lines {
        if let Some(value) = line.strip_prefix("author ") {
            author = value;
        } else if let Some(value) = line.strip_prefix("author-time ") {
            time = value.parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("summary ") {
            summary = value;
        }
    }
    let committed = hash.chars().any(|character| character != '0');
    json!({ "hash": hash, "author": author, "time": time, "summary": summary, "committed": committed })
}

/// Runs git in a directory and gives what it printed, or none when it failed.
fn run_git(directory: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(directory).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn hunk_headers_give_their_ranges_and_default_counts_to_one() {
        let diff =
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,4 @@ fn main\n+a\n@@ -10 +12 @@\n@@ -20,3 +21,0 @@\n";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 3);
        assert_eq!(hunks[0], Hunk { old_start: 3, old_count: 2, new_start: 3, new_count: 4 });
        assert_eq!(hunks[1], Hunk { old_start: 10, old_count: 1, new_start: 12, new_count: 1 });
        assert_eq!(hunks[2], Hunk { old_start: 20, old_count: 3, new_start: 21, new_count: 0 });
    }

    #[test]
    fn porcelain_blame_names_the_author_time_and_summary() {
        let output = "abc123 5 5 1\nauthor Ada Lovelace\nauthor-mail <ada@example.com>\nauthor-time 1700000000\nsummary Add the engine\nfilename x\n\tcode\n";
        let blame = parse_blame(output);
        assert_eq!(blame["author"], "Ada Lovelace");
        assert_eq!(blame["time"], 1700000000u64);
        assert_eq!(blame["summary"], "Add the engine");
        assert_eq!(blame["committed"], true);
        assert_eq!(
            parse_blame("0000000000000000000000000000000000000000 1 1 1\nauthor Not Committed Yet\n")["committed"],
            false
        );
    }

    /// A repository in a directory of its own with one committed file.
    fn repository(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-native-git-{}-{name}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&directory)
                .args(["-c", "user.name=Ada", "-c", "user.email=ada@example.com"])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-q"]);
        fs::write(directory.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "First"]);
        directory
    }

    #[test]
    fn a_changed_file_reports_its_hunks_and_a_clean_one_none() {
        let directory = repository("changes");
        let file = directory.join("a.txt");
        assert_eq!(file_changes(&file)["state"], "clean");
        fs::write(&file, "one\nTWO\nthree\nfour\n").unwrap();
        let changes = file_changes(&file);
        assert_eq!(changes["state"], "changed");
        assert_eq!(changes["hunks"][0]["newStart"], 2);
        assert_eq!(changes["hunks"][0]["oldCount"], 1);
        assert_eq!(changes["hunks"][1]["newStart"], 4);
        assert_eq!(changes["hunks"][1]["oldCount"], 0);
    }

    #[test]
    fn files_git_does_not_know_are_untracked_or_outside() {
        let directory = repository("untracked");
        fs::write(directory.join("new.txt"), "x\n").unwrap();
        assert_eq!(file_changes(&directory.join("new.txt"))["state"], "untracked");
        let outside = std::env::temp_dir().join(format!("grove-native-git-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.txt"), "x\n").unwrap();
        assert_eq!(file_changes(&outside.join("x.txt"))["state"], "outside");
    }

    #[test]
    fn blame_names_the_commit_of_a_line() {
        let directory = repository("blame");
        let blame = blame_line(&directory.join("a.txt"), 2);
        assert_eq!(blame["author"], "Ada");
        assert_eq!(blame["summary"], "First");
        assert_eq!(blame["committed"], true);
        assert_eq!(blame_line(&directory.join("a.txt"), 99), Value::Null);
    }
}
