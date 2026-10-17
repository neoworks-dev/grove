//! The programs Grove runs beside the language servers: `prettierd` to format files in projects
//! that use Prettier, and `eslint_d` to lint JavaScript and TypeScript. Both are installed with
//! the language servers, in Grove's Mason directory. They are run on the text in the editor
//! rather than the file on disk, so what they say is about what the person sees.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use editor_core::RangeEdit;

use crate::protocol::{Diagnostic, Position as LspPosition, Range};

/// The files that configure Prettier, which it looks for in a file's directory and above it.
const PRETTIER_CONFIGS: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.json5",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.mjs",
    ".prettierrc.toml",
    "prettier.config.js",
    "prettier.config.cjs",
    "prettier.config.mjs",
    "prettier.config.ts",
];

/// The files that configure ESLint.
const ESLINT_CONFIGS: &[&str] = &[
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
];

/// The extensions Prettier formats.
const PRETTIER_EXTENSIONS: &[&str] = &[
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "json", "jsonc", "json5", "css", "scss", "less", "html",
    "vue", "svelte", "md", "mdx", "yaml", "yml", "graphql",
];

/// The extensions ESLint lints.
const ESLINT_EXTENSIONS: &[&str] = &["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

/// The directory above a file with a config file of one of the names, or whose `package.json`
/// has the key, the nearest such directory first.
fn config_directory(file: &Path, names: &[&str], package_key: &str) -> Option<PathBuf> {
    for directory in file.parent()?.ancestors() {
        if names.iter().any(|name| directory.join(name).is_file()) {
            return Some(directory.to_path_buf());
        }
        if package_json_has(&directory.join("package.json"), package_key) {
            return Some(directory.to_path_buf());
        }
    }
    None
}

/// Whether a `package.json` has a top-level key.
fn package_json_has(path: &Path, key: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(package) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    package.get(key).is_some()
}

/// The directory to run Prettier in for a file, when the file is one Prettier formats and its
/// project has a Prettier config.
pub fn prettier_root(file: &Path) -> Option<PathBuf> {
    if !has_extension(file, PRETTIER_EXTENSIONS) {
        return None;
    }
    config_directory(file, PRETTIER_CONFIGS, "prettier")
}

/// The directory to run ESLint in for a file, when the file is JavaScript or TypeScript and its
/// project has an ESLint config.
pub fn eslint_root(file: &Path) -> Option<PathBuf> {
    if !has_extension(file, ESLINT_EXTENSIONS) {
        return None;
    }
    config_directory(file, ESLINT_CONFIGS, "eslintConfig")
}

/// Whether a path ends in one of the extensions.
fn has_extension(file: &Path, extensions: &[&str]) -> bool {
    let Some(extension) = file.extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_ascii_lowercase();
    extensions.contains(&extension.as_str())
}

/// What a program wrote and how it ended.
pub struct Run {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// Runs a program with some text on its input and waits for it, up to a time limit.
pub fn run_with_input(
    program: &Path,
    arguments: &[&str],
    directory: &Path,
    input: &str,
    limit: Duration,
) -> Result<Run, String> {
    let mut child = Command::new(program)
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run {}: {error}", program.display()))?;
    let mut stdin = child.stdin.take().ok_or("the program has no input")?;
    let text = input.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(text.as_bytes());
    });
    let stdout = collect(child.stdout.take());
    let stderr = collect(child.stderr.take());
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
                let stderr = stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
                return Ok(Run { stdout, stderr, success: status.success() });
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} took too long", program.display()));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Reads a stream to its end on a thread of its own, so a program that writes a lot never blocks.
fn collect(stream: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stream) = stream {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            text = String::from_utf8_lossy(&bytes).into_owned();
        }
        let _ = sender.send(text);
    });
    receiver
}

/// The text formatted by `prettierd`, which is given the file's name to choose a parser and
/// find the project's config by.
pub fn format_with_prettierd(program: &Path, file: &Path, text: &str, root: &Path) -> Result<String, String> {
    let name = file.to_string_lossy();
    let run = run_with_input(program, &[&name], root, text, Duration::from_secs(10))?;
    if !run.success {
        return Err(first_line(&run.stderr, "prettierd failed"));
    }
    Ok(run.stdout)
}

/// The first non-empty line of some text, or a fallback.
fn first_line(text: &str, fallback: &str) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(fallback).to_string()
}

/// What `eslint_d` finds in the text, as diagnostics of the source `eslint`.
pub fn lint_with_eslint_d(program: &Path, file: &Path, text: &str, root: &Path) -> Result<Vec<Diagnostic>, String> {
    let name = file.to_string_lossy();
    let arguments = ["--stdin", "--stdin-filename", &name, "--format", "json"];
    let run = run_with_input(program, &arguments, root, text, Duration::from_secs(20))?;
    match parse_eslint(&run.stdout) {
        Some(diagnostics) => Ok(diagnostics),
        None => Err(first_line(&run.stderr, "eslint_d answered with something that is not a report")),
    }
}

/// Reads ESLint's JSON report. None when the text is not one.
pub fn parse_eslint(output: &str) -> Option<Vec<Diagnostic>> {
    let report: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    let mut diagnostics = Vec::new();
    for file in report.as_array()? {
        for message in file["messages"].as_array().into_iter().flatten() {
            diagnostics.push(eslint_diagnostic(message));
        }
    }
    Some(diagnostics)
}

/// One ESLint message as a diagnostic. ESLint counts lines and columns from one, in UTF-16 units.
fn eslint_diagnostic(message: &serde_json::Value) -> Diagnostic {
    let line = message["line"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
    let column = message["column"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
    let end_line = message["endLine"].as_u64().map(|end| end.saturating_sub(1) as usize).unwrap_or(line);
    let end_column = message["endColumn"].as_u64().map(|end| end.saturating_sub(1) as usize).unwrap_or(column);
    let severity = if message["severity"].as_u64() == Some(2) { 1 } else { 2 };
    Diagnostic {
        range: Range {
            start: LspPosition { line, character: column },
            end: LspPosition { line: end_line, character: end_column },
        },
        severity: Some(severity),
        code: message.get("ruleId").filter(|rule| rule.is_string()).cloned(),
        source: Some("eslint".to_string()),
        message: message["message"].as_str().unwrap_or("eslint found a problem").to_string(),
        tags: Vec::new(),
    }
}

/// The most lines a diff of two texts compares line by line; past it one edit replaces the lot.
const LONGEST_DIFFED_MIDDLE: usize = 3000;

/// The edits that turn `old` into `new`, kept as small as whole lines allow so cursors, folds
/// and decorations in the lines that did not change stay where they are.
pub fn line_edits(old: &str, new: &str) -> Vec<RangeEdit> {
    if old == new {
        return Vec::new();
    }
    let old_lines: Vec<&str> = old.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = new.split_inclusive('\n').collect();
    let prefix = old_lines.iter().zip(&new_lines).take_while(|(a, b)| a == b).count();
    let suffix_limit = old_lines.len().min(new_lines.len()) - prefix;
    let suffix =
        old_lines.iter().rev().zip(new_lines.iter().rev()).take(suffix_limit).take_while(|(a, b)| a == b).count();
    let old_middle = &old_lines[prefix..old_lines.len() - suffix];
    let new_middle = &new_lines[prefix..new_lines.len() - suffix];
    let hunks = if old_middle.len() > LONGEST_DIFFED_MIDDLE || new_middle.len() > LONGEST_DIFFED_MIDDLE {
        vec![(0, old_middle.len(), 0, new_middle.len())]
    } else {
        hunks_between(old_middle, new_middle)
    };
    let starts = line_starts(&old_lines);
    let mut edits = Vec::new();
    for (old_from, old_to, new_from, new_to) in hunks {
        let old_hunk = &old_middle[old_from..old_to];
        let new_hunk = &new_middle[new_from..new_to];
        let first_row = prefix + old_from;
        if old_hunk.len() == new_hunk.len() {
            for (index, (old_line, new_line)) in old_hunk.iter().zip(new_hunk).enumerate() {
                let at = editor_core::Position { row: first_row + index, column: 0 };
                edits.extend(trimmed_edit(at, old_line, new_line));
            }
            continue;
        }
        let start = starts[first_row.min(starts.len() - 1)];
        edits.extend(trimmed_edit(start, &old_hunk.concat(), &new_hunk.concat()));
    }
    edits
}

/// The longest stretch of characters two texts are compared character by character over; past it
/// they are compared only by what they begin and end with.
const LONGEST_DIFFED_TEXT: usize = 500;

/// The edits that turn `old` into `new`, which start at `start`, as small as characters allow, so
/// a cursor in what stayed is not moved. None when they are equal.
fn trimmed_edit(start: editor_core::Position, old: &str, new: &str) -> Vec<RangeEdit> {
    if old == new {
        return Vec::new();
    }
    let old_chars: Vec<char> = old.chars().collect();
    let new_chars: Vec<char> = new.chars().collect();
    let prefix = old_chars.iter().zip(&new_chars).take_while(|(a, b)| a == b).count();
    let limit = old_chars.len().min(new_chars.len()) - prefix;
    let suffix = old_chars.iter().rev().zip(new_chars.iter().rev()).take(limit).take_while(|(a, b)| a == b).count();
    let old_middle = &old_chars[prefix..old_chars.len() - suffix];
    let new_middle = &new_chars[prefix..new_chars.len() - suffix];
    let origin = advance(start, &old_chars[..prefix]);
    let hunks = if old_middle.len() > LONGEST_DIFFED_TEXT || new_middle.len() > LONGEST_DIFFED_TEXT {
        vec![(0, old_middle.len(), 0, new_middle.len())]
    } else {
        hunks_between(old_middle, new_middle)
    };
    let positions = positions_of(origin, old_middle);
    hunks
        .into_iter()
        .map(|(old_from, old_to, new_from, new_to)| RangeEdit {
            start: positions[old_from],
            end: positions[old_to],
            text: new_middle[new_from..new_to].iter().collect(),
        })
        .collect()
}

/// The position before every character of a text that starts at `start`, and after the last.
fn positions_of(start: editor_core::Position, characters: &[char]) -> Vec<editor_core::Position> {
    let mut positions = Vec::with_capacity(characters.len() + 1);
    let mut position = start;
    positions.push(position);
    for character in characters {
        position = advance(position, std::slice::from_ref(character));
        positions.push(position);
    }
    positions
}

/// Where a position is after the characters that follow it.
fn advance(start: editor_core::Position, characters: &[char]) -> editor_core::Position {
    let mut position = start;
    for character in characters {
        if *character == '\n' {
            position = editor_core::Position { row: position.row + 1, column: 0 };
        } else {
            position.column += 1;
        }
    }
    position
}

/// The position at the start of every line, with one more for the end of the last line.
fn line_starts(lines: &[&str]) -> Vec<editor_core::Position> {
    let mut starts: Vec<editor_core::Position> =
        (0..lines.len()).map(|row| editor_core::Position { row, column: 0 }).collect();
    if lines.last().is_none_or(|last| last.ends_with('\n')) {
        starts.push(editor_core::Position { row: lines.len(), column: 0 });
    }
    starts
}

/// The ranges that differ between two lists of lines or characters, as `(old_from, old_to, new_from, new_to)`,
/// found from the longest common subsequence.
fn hunks_between<T: PartialEq>(old: &[T], new: &[T]) -> Vec<(usize, usize, usize, usize)> {
    let (rows, columns) = (old.len(), new.len());
    let mut lengths = vec![vec![0u32; columns + 1]; rows + 1];
    for row in (0..rows).rev() {
        for column in (0..columns).rev() {
            lengths[row][column] = if old[row] == new[column] {
                lengths[row + 1][column + 1] + 1
            } else {
                lengths[row + 1][column].max(lengths[row][column + 1])
            };
        }
    }
    let mut hunks = Vec::new();
    let (mut row, mut column) = (0, 0);
    let mut open: Option<(usize, usize)> = None;
    while row < rows || column < columns {
        if row < rows && column < columns && old[row] == new[column] {
            if let Some((old_from, new_from)) = open.take() {
                hunks.push((old_from, row, new_from, column));
            }
            row += 1;
            column += 1;
            continue;
        }
        if open.is_none() {
            open = Some((row, column));
        }
        if column < columns && (row == rows || lengths[row][column + 1] >= lengths[row + 1][column]) {
            column += 1;
        } else {
            row += 1;
        }
    }
    if let Some((old_from, new_from)) = open {
        hunks.push((old_from, rows, new_from, columns));
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::{Buffer, Command, EditorState};
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("lsp-tools-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// Applies the edits to the old text through the editor, which is how they are used.
    fn apply(old: &str, new: &str) -> (String, usize) {
        let edits = line_edits(old, new);
        let count = edits.len();
        let mut state = EditorState::new(Buffer::from_text(old));
        state.apply(&Command::ApplyEdits { edits });
        (state.buffer().slice(0..state.buffer().length()), count)
    }

    #[test]
    fn the_edits_turn_the_old_text_into_the_new_one() {
        let cases = [
            ("a\nb\nc\n", "a\nB\nc\n"),
            ("a\nb\nc\n", "a\nc\n"),
            ("a\nc\n", "a\nb\nc\n"),
            ("a\nb", "a\nb\n"),
            ("a\nb\n", "a\nb"),
            ("", "new\n"),
            ("old\n", ""),
            ("x = 1\n\n\nfoo()\nbar()\n", "x = 1\n\nfoo();\nbar();\n"),
            ("one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nFOUR\n"),
        ];
        for (old, new) in cases {
            assert_eq!(apply(old, new).0, new, "{old:?} to {new:?}");
        }
    }

    #[test]
    fn lines_that_did_not_change_are_left_out_of_the_edits() {
        let (_, count) = apply("one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nFOUR\n");
        assert_eq!(count, 2);
        assert!(line_edits("same\n", "same\n").is_empty());
    }

    #[test]
    fn a_cursor_in_an_untouched_line_stays_where_it_is() {
        let old = "a\nkeep me\nb\n";
        let mut state = EditorState::new(Buffer::from_text(old));
        state.apply(&Command::PlaceCursor { at: editor_core::Position { row: 1, column: 3 } });
        state.apply(&Command::ApplyEdits { edits: line_edits(old, "A\nkeep me\nB\n") });
        assert_eq!(state.selections().newest().head, editor_core::Position { row: 1, column: 3 });
    }

    #[test]
    fn cursors_in_lines_that_were_reformatted_stay_in_the_text_that_stayed() {
        let old = "const   a = [1,2]\nfoo( x )\n";
        let new = "const a = [1, 2];\nfoo(x);\n";
        let at = |row, column| editor_core::Position { row, column };
        for (cursor, expected) in [
            (at(0, 0), at(0, 0)),
            (at(0, 6), at(0, 6)),
            (at(0, 9), at(0, 7)),
            (at(1, 0), at(1, 0)),
            (at(1, 5), at(1, 4)),
        ] {
            let mut state = EditorState::new(Buffer::from_text(old));
            state.apply(&Command::PlaceCursor { at: cursor });
            state.apply(&Command::ApplyEdits { edits: line_edits(old, new) });
            assert_eq!(state.buffer().slice(0..state.buffer().length()), new);
            assert_eq!(state.selections().newest().head, expected, "from {cursor:?}");
        }
    }

    #[test]
    fn config_files_are_found_above_the_file() {
        let root = scratch("config");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        let file = root.join("src/deep/a.ts");
        assert_eq!(prettier_root(&file), None);
        std::fs::write(root.join("package.json"), r#"{ "name": "x", "prettier": { "semi": false } }"#).unwrap();
        assert_eq!(prettier_root(&file), Some(root.clone()));
        assert_eq!(eslint_root(&file), None);
        std::fs::write(root.join("eslint.config.mjs"), "export default []").unwrap();
        assert_eq!(eslint_root(&file), Some(root.clone()));
        assert_eq!(prettier_root(&root.join("src/a.rs")), None);
        assert_eq!(eslint_root(&root.join("src/a.css")), None);
    }

    #[test]
    fn eslint_reports_become_diagnostics_in_zero_based_positions() {
        let report = r#"[{"filePath":"/a.ts","messages":[
            {"ruleId":"no-unused-vars","severity":2,"message":"'x' is unused","line":3,"column":7,"endLine":3,"endColumn":8},
            {"ruleId":"semi","severity":1,"message":"Missing semicolon","line":4,"column":10},
            {"ruleId":null,"severity":2,"message":"Parsing error","line":1,"column":1}]}]"#;
        let diagnostics = parse_eslint(report).unwrap();
        assert_eq!(diagnostics.len(), 3);
        assert_eq!((diagnostics[0].range.start.line, diagnostics[0].range.start.character), (2, 6));
        assert_eq!(diagnostics[0].range.end.character, 7);
        assert_eq!(diagnostics[0].severity, Some(1));
        assert_eq!(diagnostics[1].severity, Some(2));
        assert_eq!(diagnostics[1].range.end, diagnostics[1].range.start);
        assert!(diagnostics[2].code.is_none());
        assert_eq!(diagnostics[0].source.as_deref(), Some("eslint"));
        assert!(parse_eslint("Error: no config").is_none());
    }

    #[test]
    fn programs_are_run_on_the_text_and_their_failures_say_why() {
        let directory = scratch("run");
        let script = directory.join("upper");
        std::fs::write(&script, "#!/bin/sh\ntr a-z A-Z\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let formatted = format_with_prettierd(&script, &directory.join("a.ts"), "let x\n", &directory).unwrap();
        assert_eq!(formatted, "LET X\n");
        let failing = directory.join("failing");
        std::fs::write(&failing, "#!/bin/sh\ncat >/dev/null\necho '[error] bad syntax' >&2\nexit 2\n").unwrap();
        std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = format_with_prettierd(&failing, &directory.join("a.ts"), "x", &directory).unwrap_err();
        assert!(error.contains("bad syntax"), "{error}");
        let slow = directory.join("slow");
        std::fs::write(&slow, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = run_with_input(&slow, &[], &directory, "", Duration::from_millis(100)).err().unwrap();
        assert!(error.contains("too long"), "{error}");
    }
}
