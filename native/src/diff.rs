//! What the diff view and the git gutter ask of the host: compare a document with another text
//! and draw the difference, act on the hunk under a row (stage it, unstage it, put the old lines
//! back), read a file as git has it, and throw away a file's changes.
//!
//! Rows are counted from zero, and a hunk is `{ oldStart, oldLen, newStart, newLen }` as
//! `editor_core::diff::Hunk` has it.
//!
//! Commands:
//!
//! - `diff_apply { newId, oldId?, oldText?, mode, source }` compares the text of document `newId`
//!   with the old text (document `oldId`, or `oldText`), puts the decorations of `source` on it,
//!   and answers `{ hunks }`. A `mode` of `inline` draws the removed lines in the new document; `split`
//!   draws one side in each of the two documents, with fillers so their rows line up.
//! - `diff_hunks { id, oldText }` answers `{ hunks }` of document `id` against the old text,
//!   without drawing anything.
//! - `diff_preview { id, oldText, row, source }` shows the old lines of the hunk at `row` as a
//!   block above it, and answers whether there is one. No hunk there removes the block.
//! - `hunk_stage { id, row }` stages the hunk of document `id` at `row` against the index.
//!   `hunk_unstage { path, row }` takes the hunk at `row` of the index out of it again.
//!   `hunk_revert { id, base, row }` puts the old lines of the hunk against `head` or `index` back
//!   in the document. Each answers `{ ok }` or fails with what git said.
//! - `git_base_text { path, base }` answers `{ exists, text }` for the file as `head` or `index`
//!   has it.
//! - `git_discard { paths: [{ path, untracked }] }` puts files back as the index has them, and
//!   deletes the untracked ones.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use editor_core::diff::{self, Hunk, Side};
use editor_core::{Command as EditorCommand, Decoration, DocumentId};
use serde_json::{Value, json};
use svelte_gpui::{CommandError, Commands};

use crate::editor::SharedDocuments;
use crate::git::run_git;

/// Registers the diff and hunk commands over the documents.
pub fn register(commands: Commands, documents: SharedDocuments) -> Commands {
    let applier = documents.clone();
    let previewer = documents.clone();
    let lister = documents.clone();
    let stager = documents.clone();
    let reverter = documents;
    commands
        .command("diff_apply", move |args| diff_apply(&applier, &args))
        .command("diff_preview", move |args| diff_preview(&previewer, &args))
        .command("diff_hunks", move |args| diff_hunks(&lister, &args))
        .command("hunk_stage", move |args| hunk_stage(&stager, &args))
        .command("hunk_unstage", |args| hunk_unstage(&args))
        .command("hunk_revert", move |args| hunk_revert(&reverter, &args))
        .command("git_base_text", |args| git_base_text(&args))
        .command("git_discard", |args| git_discard(&args))
}

/// A hunk as the UI reads it.
fn hunk_json(hunk: &Hunk) -> Value {
    json!({ "oldStart": hunk.old_start, "oldLen": hunk.old_len, "newStart": hunk.new_start, "newLen": hunk.new_len })
}

/// A command argument that must be a string.
fn string_argument(args: &Value, name: &str) -> Result<String, CommandError> {
    match args.get(name).and_then(Value::as_str) {
        Some(text) => Ok(text.to_string()),
        None => Err(CommandError::with_code("InvalidArguments", format!("this command takes a string {name}"))),
    }
}

/// A command argument that must be a number, such as a row or a document id.
fn number_argument(args: &Value, name: &str) -> Result<u64, CommandError> {
    match args.get(name).and_then(Value::as_u64) {
        Some(number) => Ok(number),
        None => Err(CommandError::with_code("InvalidArguments", format!("this command takes a number {name}"))),
    }
}

/// Puts a source's decorations on a document, replacing what it had.
fn set_decorations(documents: &SharedDocuments, id: DocumentId, source: &str, decorations: Vec<Decoration>) -> Result<(), CommandError> {
    let command = EditorCommand::SetDecorations { source: source.to_string(), decorations };
    match documents.apply(id, &command) {
        Some(_) => Ok(()),
        None => Err(CommandError::with_code("NoDocument", format!("document {id} is not open"))),
    }
}

/// The old text of a comparison: the text of document `oldId`, else `oldText`.
fn old_text_argument(documents: &SharedDocuments, args: &Value) -> Result<String, CommandError> {
    if let Some(id) = args.get("oldId").and_then(Value::as_u64) {
        return documents.text(id);
    }
    string_argument(args, "oldText")
}

/// The `diff_apply` command.
fn diff_apply(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let new_id = number_argument(args, "newId")?;
    let source = string_argument(args, "source")?;
    let mode = string_argument(args, "mode")?;
    let new_text = documents.text(new_id)?;
    let old_text = old_text_argument(documents, args)?;
    if mode == "split" {
        let old_id = number_argument(args, "oldId")?;
        let (old_side, _) = diff::decorations(&old_text, &new_text, Side::Old);
        set_decorations(documents, old_id, &source, old_side)?;
        let (new_side, hunks) = diff::decorations(&old_text, &new_text, Side::New);
        set_decorations(documents, new_id, &source, new_side)?;
        return Ok(json!({ "hunks": hunks.iter().map(hunk_json).collect::<Vec<_>>() }));
    }
    let (decorations, hunks) = diff::decorations(&old_text, &new_text, Side::Inline);
    set_decorations(documents, new_id, &source, decorations)?;
    Ok(json!({ "hunks": hunks.iter().map(hunk_json).collect::<Vec<_>>() }))
}

/// The `diff_hunks` command.
fn diff_hunks(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let id = number_argument(args, "id")?;
    let old_text = string_argument(args, "oldText")?;
    let new_text = documents.text(id)?;
    let found = diff::hunks(&diff::split_lines(&old_text), &diff::split_lines(&new_text));
    Ok(json!({ "hunks": found.iter().map(hunk_json).collect::<Vec<_>>() }))
}

/// The `diff_preview` command.
fn diff_preview(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let id = number_argument(args, "id")?;
    let row = number_argument(args, "row")? as usize;
    let source = string_argument(args, "source")?;
    let old_text = string_argument(args, "oldText")?;
    let new_text = documents.text(id)?;
    let Some((decorations, hunk)) = diff::preview_decorations(&old_text, &new_text, row) else {
        set_decorations(documents, id, &source, Vec::new())?;
        return Ok(json!({ "found": false }));
    };
    set_decorations(documents, id, &source, decorations)?;
    Ok(json!({ "found": true, "hunk": hunk_json(&hunk) }))
}

/// Where a file is in its repository: the root, and the path from the root with `/` separators.
struct RepositoryFile {
    root: PathBuf,
    relative: String,
}

/// Finds the repository a file belongs to, even when the file itself is gone.
fn repository_file(path: &Path) -> Result<RepositoryFile, CommandError> {
    let not_in_repository = || CommandError::with_code("NotInRepository", format!("{} is not in a git repository", path.display()));
    let directory = path.parent().ok_or_else(not_in_repository)?;
    let name = path.file_name().ok_or_else(not_in_repository)?;
    let root = run_git(directory, &["rev-parse", "--show-toplevel"]).ok_or_else(not_in_repository)?;
    let root = PathBuf::from(root.trim()).canonicalize().map_err(|_| not_in_repository())?;
    let directory = directory.canonicalize().map_err(|_| not_in_repository())?;
    let relative = directory.join(name).strip_prefix(&root).map_err(|_| not_in_repository())?.to_path_buf();
    Ok(RepositoryFile { root, relative: relative.to_string_lossy().replace('\\', "/") })
}

/// The text of a file as `head` or `index` has it, or none when that has no such file.
fn base_text(file: &RepositoryFile, base: &str) -> Result<Option<String>, CommandError> {
    let spec = match base {
        "head" => format!("HEAD:{}", file.relative),
        "index" => format!(":{}", file.relative),
        other => {
            return Err(CommandError::with_code("InvalidArguments", format!("a base is head or index, not {other:?}")));
        }
    };
    Ok(run_git(&file.root, &["show", &spec]))
}

/// The `git_base_text` command.
fn git_base_text(args: &Value) -> Result<Value, CommandError> {
    let path = string_argument(args, "path")?;
    let base = string_argument(args, "base")?;
    let file = repository_file(Path::new(&path))?;
    match base_text(&file, &base)? {
        Some(text) => Ok(json!({ "exists": true, "text": text })),
        None => Ok(json!({ "exists": false, "text": "" })),
    }
}

/// The path of a document that has a file.
fn document_path(documents: &SharedDocuments, id: DocumentId) -> Result<String, CommandError> {
    let path = documents.lock().get(id).and_then(|document| document.path().map(|path| path.display().to_string()));
    match path {
        Some(path) => Ok(path),
        None => Err(CommandError::with_code("NoFile", format!("document {id} has no file"))),
    }
}

/// The hunk of a comparison that a row of the new text belongs to.
fn hunk_at(old_text: &str, new_text: &str, row: usize) -> Result<Hunk, CommandError> {
    let found = diff::hunks(&diff::split_lines(old_text), &diff::split_lines(new_text));
    match found.into_iter().find(|hunk| hunk.covers_new_row(row)) {
        Some(hunk) => Ok(hunk),
        None => Err(CommandError::with_code("NoHunk", "there is no changed hunk here")),
    }
}

/// The `hunk_stage` command: the hunk the document has over the index goes into the index.
fn hunk_stage(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let id = number_argument(args, "id")?;
    let row = number_argument(args, "row")? as usize;
    let path = document_path(documents, id)?;
    let file = repository_file(Path::new(&path))?;
    let index_text = base_text(&file, "index")?.unwrap_or_default();
    let new_text = documents.text(id)?;
    let hunk = hunk_at(&index_text, &new_text, row)?;
    let patch = diff::hunk_patch(&file.relative, &index_text, &new_text, &hunk);
    apply_to_index(&file, &patch, false)?;
    Ok(json!({ "ok": true }))
}

/// The `hunk_unstage` command: the hunk the index has over HEAD goes back out of the index.
fn hunk_unstage(args: &Value) -> Result<Value, CommandError> {
    let path = string_argument(args, "path")?;
    let row = number_argument(args, "row")? as usize;
    let file = repository_file(Path::new(&path))?;
    let head_text = base_text(&file, "head")?.unwrap_or_default();
    let index_text = base_text(&file, "index")?.unwrap_or_default();
    let hunk = hunk_at(&head_text, &index_text, row)?;
    let patch = diff::hunk_patch(&file.relative, &head_text, &index_text, &hunk);
    apply_to_index(&file, &patch, true)?;
    Ok(json!({ "ok": true }))
}

/// Applies a zero-context patch to the index, or takes it out of the index when `reverse` is set.
fn apply_to_index(file: &RepositoryFile, patch: &str, reverse: bool) -> Result<(), CommandError> {
    let mut arguments = vec!["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
    if reverse {
        arguments.push("--reverse");
    }
    arguments.push("-");
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&file.root)
        .args(&arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CommandError::with_code("GitFailed", format!("could not run git: {error}")))?;
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(patch.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| CommandError::with_code("GitFailed", format!("could not run git: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(CommandError::with_code("GitFailed", message))
}

/// The `hunk_revert` command: the old lines of the hunk replace its new ones in the document.
fn hunk_revert(documents: &SharedDocuments, args: &Value) -> Result<Value, CommandError> {
    let id = number_argument(args, "id")?;
    let row = number_argument(args, "row")? as usize;
    let base = string_argument(args, "base")?;
    let path = document_path(documents, id)?;
    let file = repository_file(Path::new(&path))?;
    let old_text = base_text(&file, &base)?.unwrap_or_default();
    let new_text = documents.text(id)?;
    let hunk = hunk_at(&old_text, &new_text, row)?;
    let (start, end, replacement) = revert_edit(&old_text, &new_text, &hunk);
    documents.apply(id, &EditorCommand::ReplaceRange { start, end, text: replacement });
    Ok(json!({ "ok": true }))
}

/// The edit that turns a hunk's new lines back into its old ones: the character range of the
/// new text to replace, and what goes there.
fn revert_edit(old_text: &str, new_text: &str, hunk: &Hunk) -> (usize, usize, String) {
    let old = diff::split_lines(old_text);
    let new = diff::split_lines(new_text);
    let starts = line_start_offsets(new_text);
    let total = new_text.chars().count();
    let start = starts.get(hunk.new_start).copied().unwrap_or(total);
    let end = starts.get(hunk.new_start + hunk.new_len).copied().unwrap_or(total);
    let old_lines = &old[hunk.old_lines()];
    let reaches_end = hunk.new_start + hunk.new_len >= new.len();
    let last_line_is_open = reaches_end && !new.is_empty() && !new_text.ends_with('\n');
    if !last_line_is_open {
        let replacement: String = old_lines.iter().map(|line| format!("{line}\n")).collect();
        return (start, end, replacement);
    }
    // The last line has no line break, so a break goes before the lines put back and not after.
    if hunk.new_len == 0 {
        return (total, total, format!("\n{}", old_lines.join("\n")));
    }
    if old_lines.is_empty() {
        return (start.saturating_sub(1), total, String::new());
    }
    (start, total, old_lines.join("\n"))
}

/// The character offset at which each line of a text starts.
fn line_start_offsets(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (offset, character) in text.chars().enumerate() {
        if character == '\n' {
            starts.push(offset + 1);
        }
    }
    starts
}

/// The `git_discard` command.
fn git_discard(args: &Value) -> Result<Value, CommandError> {
    let Some(entries) = args.get("paths").and_then(Value::as_array) else {
        return Err(CommandError::with_code("InvalidArguments", "this command takes a list of paths"));
    };
    for entry in entries {
        let path = string_argument(entry, "path")?;
        let untracked = entry.get("untracked").and_then(Value::as_bool).unwrap_or(false);
        discard_file(Path::new(&path), untracked)?;
    }
    Ok(json!({ "ok": true }))
}

/// Puts one file back as the index has it, or deletes it when git does not know it.
fn discard_file(path: &Path, untracked: bool) -> Result<(), CommandError> {
    if untracked {
        return std::fs::remove_file(path)
            .map_err(|error| CommandError::with_code("DiscardFailed", format!("could not delete {}: {error}", path.display())));
    }
    let file = repository_file(path)?;
    let restored = run_git(&file.root, &["restore", "--", &file.relative]);
    match restored {
        Some(_) => Ok(()),
        None => Err(CommandError::with_code("DiscardFailed", format!("git could not restore {}", file.relative))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svelte_gpui::Emitter;

    fn hunk(old_start: usize, old_len: usize, new_start: usize, new_len: usize) -> Hunk {
        Hunk { old_start, old_len, new_start, new_len }
    }

    /// The new text after reverting a hunk by the edit `revert_edit` makes.
    fn reverted(old_text: &str, new_text: &str, hunk: Hunk) -> String {
        let (start, end, replacement) = revert_edit(old_text, new_text, &hunk);
        let characters: Vec<char> = new_text.chars().collect();
        let before: String = characters[..start].iter().collect();
        let after: String = characters[end..].iter().collect();
        format!("{before}{replacement}{after}")
    }

    #[test]
    fn reverting_a_hunk_puts_its_old_lines_back() {
        assert_eq!(reverted("a\nb\nc\n", "a\nB\nB2\nc\n", hunk(1, 1, 1, 2)), "a\nb\nc\n");
        assert_eq!(reverted("a\nb\nc\n", "a\nc\n", hunk(1, 1, 1, 0)), "a\nb\nc\n");
        assert_eq!(reverted("a\nc\n", "a\nb\nc\n", hunk(1, 0, 1, 1)), "a\nc\n");
        assert_eq!(reverted("a\n", "a\nb\n", hunk(1, 0, 1, 1)), "a\n");
    }

    #[test]
    fn reverting_at_the_end_of_a_text_without_a_final_line_break() {
        assert_eq!(reverted("a\nb", "a\nB", hunk(1, 1, 1, 1)), "a\nb");
        assert_eq!(reverted("a", "a\nb", hunk(1, 0, 1, 1)), "a");
        assert_eq!(reverted("a\nb", "a", hunk(1, 1, 1, 0)), "a\nb");
    }

    /// A repository in a directory of its own with one committed file.
    fn repository(name: &str, text: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("grove-native-diff-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
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
        std::fs::write(directory.join("a.txt"), text).unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-q", "-m", "First"]);
        directory.canonicalize().unwrap()
    }

    fn git_output(directory: &Path, args: &[&str]) -> String {
        run_git(directory, args).unwrap()
    }

    #[test]
    fn staging_a_hunk_puts_only_that_hunk_in_the_index() {
        let directory = repository("stage", "1\n2\n3\n4\n5\n6\n");
        let file = directory.join("a.txt");
        std::fs::write(&file, "1\nTWO\n3\n4\n5\nSIX\n").unwrap();
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&file.display().to_string()).unwrap().id;
        hunk_stage(&documents, &json!({ "id": id, "row": 5 })).unwrap();
        assert_eq!(git_output(&directory, &["show", ":a.txt"]), "1\n2\n3\n4\n5\nSIX\n");
        assert_eq!(git_output(&directory, &["diff", "--name-only"]).trim(), "a.txt");
        let error = hunk_stage(&documents, &json!({ "id": id, "row": 2 })).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("NoHunk"));
    }

    #[test]
    fn staging_works_on_the_text_in_the_editor_not_the_file_on_disk() {
        let directory = repository("stage-buffer", "1\n2\n3\n");
        let file = directory.join("a.txt");
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&file.display().to_string()).unwrap().id;
        let edit = EditorCommand::ReplaceRange { start: 2, end: 3, text: "TWO".into() };
        documents.apply(id, &edit).unwrap();
        hunk_stage(&documents, &json!({ "id": id, "row": 1 })).unwrap();
        assert_eq!(git_output(&directory, &["show", ":a.txt"]), "1\nTWO\n3\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1\n2\n3\n");
    }

    #[test]
    fn unstaging_a_hunk_takes_it_out_of_the_index_and_leaves_the_file() {
        let directory = repository("unstage", "1\n2\n3\n4\n5\n6\n");
        let file = directory.join("a.txt");
        std::fs::write(&file, "1\nTWO\n3\n4\n5\nSIX\n").unwrap();
        git_output(&directory, &["add", "a.txt"]);
        hunk_unstage(&json!({ "path": file.display().to_string(), "row": 1 })).unwrap();
        assert_eq!(git_output(&directory, &["show", ":a.txt"]), "1\n2\n3\n4\n5\nSIX\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1\nTWO\n3\n4\n5\nSIX\n");
    }

    #[test]
    fn reverting_a_hunk_edits_the_document_and_not_the_file() {
        let directory = repository("revert", "1\n2\n3\n");
        let file = directory.join("a.txt");
        std::fs::write(&file, "1\nTWO\n3\n").unwrap();
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open(&file.display().to_string()).unwrap().id;
        hunk_revert(&documents, &json!({ "id": id, "base": "head", "row": 1 })).unwrap();
        assert_eq!(documents.text(id).unwrap(), "1\n2\n3\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "1\nTWO\n3\n");
    }

    #[test]
    fn base_text_reads_head_and_the_index_and_says_when_a_file_is_new() {
        let directory = repository("base", "1\n");
        let file = directory.join("a.txt");
        std::fs::write(&file, "2\n").unwrap();
        git_output(&directory, &["add", "a.txt"]);
        let path = file.display().to_string();
        assert_eq!(git_base_text(&json!({ "path": path, "base": "head" })).unwrap()["text"], "1\n");
        assert_eq!(git_base_text(&json!({ "path": path, "base": "index" })).unwrap()["text"], "2\n");
        let fresh = directory.join("new.txt").display().to_string();
        assert_eq!(git_base_text(&json!({ "path": fresh, "base": "head" })).unwrap()["exists"], false);
    }

    #[test]
    fn discarding_restores_tracked_files_and_deletes_untracked_ones() {
        let directory = repository("discard", "1\n");
        let tracked = directory.join("a.txt");
        let untracked = directory.join("new.txt");
        std::fs::write(&tracked, "changed\n").unwrap();
        std::fs::write(&untracked, "x\n").unwrap();
        let paths = json!({ "paths": [
            { "path": tracked.display().to_string() },
            { "path": untracked.display().to_string(), "untracked": true },
        ] });
        git_discard(&paths).unwrap();
        assert_eq!(std::fs::read_to_string(&tracked).unwrap(), "1\n");
        assert!(!untracked.exists());
    }

    #[test]
    fn a_comparison_puts_decorations_on_the_document() {
        let documents = SharedDocuments::new(Emitter::default());
        let id = documents.open_text("a.rs", "a\nB\nc\n").unwrap().id;
        let args = json!({ "newId": id, "oldText": "a\nb\nc\n", "mode": "inline", "source": "diff" });
        let answer = diff_apply(&documents, &args).unwrap();
        assert_eq!(answer["hunks"][0]["newStart"], 1);
        assert!(documents.lock().get(id).unwrap().state.decoration_count("diff") > 0);
    }
}
