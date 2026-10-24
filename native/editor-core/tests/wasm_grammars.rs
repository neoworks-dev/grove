//! Grammars that extensions bring as WebAssembly: that one loads and highlights, that a file is
//! matched to it, that a compiled-in language is never replaced, and that bad grammars are refused.
//! The grammar is the one the `grove-zig` sample ships, so what runs here is what an install runs.
//!
//! The grammars handed over are process-wide, so each test takes `LOCK` and sets what it needs.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use editor_core::syntax::{GrammarSpec, language_for_name, language_for_path, set_grammars};
use editor_core::{Buffer, Command, EditorState};

static LOCK: Mutex<()> = Mutex::new(());

/// Takes the lock that keeps tests from changing each other's grammars.
fn exclusive() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The directory of the sample extension that ships the Zig grammar.
fn sample() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/extensions/grove-zig")
}

/// The sample's Zig grammar as an extension would hand it over, with queries from its files.
fn zig_spec() -> GrammarSpec {
    let read = |name: &str| std::fs::read_to_string(sample().join(name)).unwrap();
    GrammarSpec {
        language: "zig".to_string(),
        symbol: "zig".to_string(),
        wasm: std::fs::read(sample().join("grammars/zig.wasm")).unwrap(),
        highlights: read("queries/highlights.scm"),
        injections: None,
        locals: Some(read("queries/locals.scm")),
        extensions: vec!["zig".to_string(), "zon".to_string()],
        file_names: vec!["build.zig.zon".to_string()],
    }
}

/// A state over text that is named like a file, so its language is the file's.
fn state_named(name: &str, text: &str) -> EditorState {
    EditorState::new(Buffer::from_text_named(text, Path::new(name)))
}

/// The highlighted pieces of a row as the text and the name of its highlight.
fn pieces(state: &EditorState, row: usize) -> Vec<(String, &'static str)> {
    let line: Vec<char> = state.buffer().line(row).chars().collect();
    let spans = state.highlights(row..row + 1).remove(0);
    spans.iter().map(|span| (line[span.start_column..span.end_column].iter().collect(), span.id.name())).collect()
}

/// Whether a row has the text coloured as the given highlight.
fn has(state: &EditorState, row: usize, text: &str, name: &str) -> bool {
    pieces(state, row).iter().any(|(piece, piece_name)| piece == text && *piece_name == name)
}

const ZIG: &str = "const std = @import(\"std\");\n\npub fn add(value: u32, other: u32) u32 {\n    // sum\n    return value + other;\n}\n";

#[test]
fn a_wasm_grammar_loads_and_its_queries_produce_highlights() {
    let _lock = exclusive();
    assert!(set_grammars(vec![zig_spec()]).is_empty());
    let state = state_named("main.zig", ZIG);
    assert_eq!(state.language_name(), Some("zig"));
    assert!(has(&state, 0, "const", "keyword"));
    assert!(has(&state, 0, "\"std\"", "string"));
    assert!(has(&state, 2, "fn", "keyword"));
    assert!(has(&state, 2, "add", "function"));
    assert!(has(&state, 2, "u32", "type.builtin"));
    assert!(has(&state, 3, "// sum", "comment"));
}

#[test]
fn files_are_matched_by_extension_and_by_name() {
    let _lock = exclusive();
    assert!(set_grammars(vec![zig_spec()]).is_empty());
    for path in ["main.zig", "src/deep/lib.zig", "build.zig.zon", "x.zon"] {
        let found = language_for_path(Path::new(path));
        assert_eq!(found.map(|language| language.name), Some("zig"), "{path}");
    }
    assert!(language_for_path(Path::new("notes.txt")).is_none());
    assert_eq!(language_for_name("zig").map(|language| language.name), Some("zig"));
    assert!(set_grammars(Vec::new()).is_empty());
    assert!(language_for_path(Path::new("main.zig")).is_none());
}

#[test]
fn a_compiled_in_language_is_never_replaced() {
    let _lock = exclusive();
    let mut taking_over = zig_spec();
    taking_over.language = "rust".to_string();
    taking_over.extensions = vec!["rs".to_string(), "rsx".to_string()];
    let rejected = set_grammars(vec![taking_over]);
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].language, "rust");
    let found = language_for_path(Path::new("lib.rs")).unwrap();
    assert_eq!(found.name, "rust");
    assert!(language_for_path(Path::new("lib.rsx")).is_none());
    let state = state_named("lib.rs", "fn main() {}\n");
    assert!(has(&state, 0, "fn", "keyword"));
}

#[test]
fn a_built_in_extension_goes_to_the_built_in_language() {
    let _lock = exclusive();
    let mut claiming = zig_spec();
    claiming.extensions.push("toml".to_string());
    assert!(set_grammars(vec![claiming]).is_empty());
    assert_eq!(language_for_path(Path::new("Cargo.toml")).map(|language| language.name), Some("toml"));
    assert_eq!(language_for_path(Path::new("a.zig")).map(|language| language.name), Some("zig"));
    set_grammars(Vec::new());
}

#[test]
fn grammars_that_cannot_work_are_refused_with_a_reason() {
    let _lock = exclusive();
    let mut not_wasm = zig_spec();
    not_wasm.language = "broken".to_string();
    not_wasm.wasm = b"not a module".to_vec();
    let mut bad_query = zig_spec();
    bad_query.language = "oddquery".to_string();
    bad_query.highlights = "(no_such_node) @keyword".to_string();
    let mut wrong_symbol = zig_spec();
    wrong_symbol.language = "wrongsymbol".to_string();
    wrong_symbol.symbol = "nothing_exports_this".to_string();
    let rejected = set_grammars(vec![not_wasm, bad_query, wrong_symbol, zig_spec()]);
    let names: Vec<&str> = rejected.iter().map(|rejected| rejected.language.as_str()).collect();
    assert_eq!(names, ["broken", "oddquery", "wrongsymbol"]);
    assert!(rejected[1].reason.contains("highlights do not compile"), "{}", rejected[1].reason);
    assert!(language_for_path(Path::new("main.zig")).is_some());
    set_grammars(Vec::new());
}

#[test]
fn a_document_opened_before_its_grammar_arrived_is_highlighted_once_it_does() {
    let _lock = exclusive();
    set_grammars(Vec::new());
    let mut state = state_named("late.zig", ZIG);
    assert_eq!(state.language_name(), None);
    assert!(pieces(&state, 0).is_empty());
    assert!(!state.refresh_syntax());
    assert!(set_grammars(vec![zig_spec()]).is_empty());
    assert!(state.refresh_syntax());
    assert!(has(&state, 0, "const", "keyword"));
    assert!(!state.refresh_syntax());
    set_grammars(Vec::new());
}

#[test]
fn editing_a_wasm_document_keeps_its_highlights_right() {
    let _lock = exclusive();
    assert!(set_grammars(vec![zig_spec()]).is_empty());
    let mut state = state_named("edit.zig", ZIG);
    state.apply(&Command::InsertText { text: "var count: u8 = 0;\n".to_string() });
    assert!(has(&state, 0, "var", "keyword"));
    assert!(has(&state, 1, "const", "keyword"));
    let fresh = state_named("edit.zig", &state.buffer().slice(0..state.buffer().length()));
    for row in 0..state.buffer().line_count() {
        assert_eq!(pieces(&state, row), pieces(&fresh, row), "row {row}");
    }
    set_grammars(Vec::new());
}

#[test]
fn a_use_of_a_local_name_is_coloured_as_its_definition() {
    let _lock = exclusive();
    let without_locals = {
        let mut spec = zig_spec();
        spec.locals = None;
        spec
    };
    assert!(set_grammars(vec![without_locals]).is_empty());
    let plain = state_named("a.zig", ZIG);
    assert!(has(&plain, 2, "value", "variable.parameter"));
    assert!(has(&plain, 4, "value", "variable"), "{:?}", pieces(&plain, 4));

    assert!(set_grammars(vec![zig_spec()]).is_empty());
    let resolved = state_named("a.zig", ZIG);
    assert!(has(&resolved, 4, "value", "variable.parameter"), "{:?}", pieces(&resolved, 4));
    assert!(has(&resolved, 4, "other", "variable.parameter"), "{:?}", pieces(&resolved, 4));
    set_grammars(Vec::new());
}
