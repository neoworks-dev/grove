//! Syntax highlighting through `EditorState`: which language a file gets, what its text is
//! coloured as, and that the colours stay right while the text is edited.

use std::path::Path;
use std::time::Instant;

use editor_core::syntax::{all_languages, language_for_name, language_for_path};
use editor_core::{Buffer, Command, EditorState, Motion, Position};

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

/// Every row's highlights.
fn all_pieces(state: &EditorState) -> Vec<Vec<(String, &'static str)>> {
    (0..state.buffer().line_count()).map(|row| pieces(state, row)).collect()
}

/// The text of the state's buffer.
fn text_of(state: &EditorState) -> String {
    state.buffer().slice(0..state.buffer().length())
}

/// Asserts that the incrementally updated highlights equal those of a fresh parse of the same text.
fn assert_same_as_fresh_parse(state: &EditorState, name: &str) {
    let fresh = state_named(name, &text_of(state));
    assert_eq!(all_pieces(state), all_pieces(&fresh));
}

fn type_text(state: &mut EditorState, text: &str) {
    state.apply(&Command::InsertText { text: text.to_string() });
}

fn at(row: usize, column: usize) -> Position {
    Position { row, column }
}

#[test]
fn files_get_their_language_from_the_extension_or_name() {
    let names = [
        ("src/main.rs", "rust"),
        ("a.ts", "typescript"),
        ("a.tsx", "tsx"),
        ("a.js", "javascript"),
        ("a.jsx", "javascript"),
        ("package.json", "json"),
        ("README.md", "markdown"),
        ("style.css", "css"),
        ("index.html", "html"),
        ("main.go", "go"),
        ("init.lua", "lua"),
        ("run.sh", "bash"),
        (".bashrc", "bash"),
        ("App.svelte", "svelte"),
    ];
    for (path, language) in names {
        let found = language_for_path(Path::new(path));
        assert_eq!(found.map(|found| found.name), Some(language), "{path}");
    }
    assert!(language_for_path(Path::new("notes.txt")).is_none());
    assert!(language_for_path(Path::new("Makefile")).is_none());
}

#[test]
fn code_fences_find_languages_by_name_and_alias() {
    assert_eq!(language_for_name("ts").map(|language| language.name), Some("typescript"));
    assert_eq!(language_for_name("Rust").map(|language| language.name), Some("rust"));
    assert_eq!(language_for_name("shell").map(|language| language.name), Some("bash"));
    assert!(language_for_name("cobol").is_none());
}

#[test]
fn every_languages_queries_compile() {
    for language in all_languages() {
        assert!(language.highlight_query().is_some(), "highlights of {}", language.name);
    }
    for name in ["markdown", "html", "svelte"] {
        let language = language_for_name(name).unwrap();
        assert!(language.injection_query().is_some(), "injections of {name}");
    }
}

#[test]
fn a_rust_snippet_is_highlighted() {
    let state = state_named("a.rs", "fn main() {\n    let x = 1; // done\n}\n");
    assert_eq!(state.language_name(), Some("rust"));
    assert!(has(&state, 0, "fn", "keyword"));
    assert!(has(&state, 0, "main", "function"));
    assert!(has(&state, 1, "let", "keyword"));
    assert!(has(&state, 1, "1", "constant.builtin"));
    assert!(has(&state, 1, "// done", "comment"));
}

#[test]
fn typescript_gets_javascript_and_type_highlights() {
    let state = state_named("a.ts", "const name: string = \"x\";\ninterface Box { size: number }\n");
    assert!(has(&state, 0, "const", "keyword"));
    assert!(has(&state, 0, "\"x\"", "string"));
    assert!(has(&state, 0, "string", "type.builtin"));
    assert!(has(&state, 1, "interface", "keyword"));
}

#[test]
fn json_markdown_css_go_lua_and_bash_are_highlighted() {
    assert!(has(&state_named("a.json", "{\"key\": 12}\n"), 0, "12", "number"));
    assert!(has(&state_named("a.md", "# Title\n"), 0, "Title", "title"));
    assert!(has(&state_named("a.css", "a { color: red; }\n"), 0, "color", "property"));
    assert!(has(&state_named("a.go", "package main\nfunc main() {}\n"), 1, "func", "keyword"));
    assert!(has(&state_named("a.lua", "local x = 1\n"), 0, "local", "keyword"));
    assert!(has(&state_named("a.sh", "if true; then echo hi; fi\n"), 0, "if", "keyword"));
    assert!(has(&state_named("a.html", "<div class=\"a\"></div>\n"), 0, "div", "tag"));
}

#[test]
fn files_of_unknown_languages_have_no_highlights() {
    let state = state_named("notes.txt", "fn main() {}\n");
    assert_eq!(state.language_name(), None);
    assert!(pieces(&state, 0).is_empty());
    assert!(pieces(&EditorState::new(Buffer::from_text("fn main() {}")), 0).is_empty());
}

#[test]
fn columns_count_characters_not_bytes() {
    let state = state_named("a.rs", "let ü = \"ä\";\n");
    assert!(has(&state, 0, "\"ä\"", "string"));
}

#[test]
fn rows_past_the_end_come_back_empty() {
    let state = state_named("a.rs", "fn main() {}");
    let rows = state.highlights(0..5);
    assert_eq!(rows.len(), 5);
    assert!(rows[3].is_empty());
}

#[test]
fn typing_reparses_incrementally_and_the_highlights_follow() {
    let mut state = state_named("a.rs", "fn main() {\n    \n}\n");
    state.apply(&Command::PlaceCursor { at: at(1, 4) });
    type_text(&mut state, "let x = ");
    assert!(has(&state, 1, "let", "keyword"));
    assert!(!has(&state, 1, "x", "constant.builtin"));
    type_text(&mut state, "42;");
    assert!(has(&state, 1, "42", "constant.builtin"));
    assert_same_as_fresh_parse(&state, "a.rs");

    // Opening a string changes how what comes after it parses, and closing it changes it back.
    state.apply(&Command::PlaceCursor { at: at(0, 0) });
    type_text(&mut state, "\"");
    assert_same_as_fresh_parse(&state, "a.rs");
    type_text(&mut state, "\"");
    assert_same_as_fresh_parse(&state, "a.rs");
}

#[test]
fn undo_and_redo_bring_the_highlights_back_with_the_text() {
    let mut state = state_named("a.rs", "fn a() {}\n");
    state.apply(&Command::PlaceCursor { at: at(0, 0) });
    type_text(&mut state, "pub ");
    assert!(has(&state, 0, "pub", "keyword"));
    state.apply(&Command::Undo);
    assert!(!has(&state, 0, "pub", "keyword"));
    assert_same_as_fresh_parse(&state, "a.rs");
    state.apply(&Command::Redo);
    assert!(has(&state, 0, "pub", "keyword"));
    assert_same_as_fresh_parse(&state, "a.rs");
}

#[test]
fn several_cursors_editing_at_once_keep_the_tree_right() {
    let mut state = state_named("a.ts", "let a = 1;\nlet b = 2;\nlet c = 3;\n");
    state.apply(&Command::PlaceCursor { at: at(0, 3) });
    state.apply(&Command::AddCursorBelow);
    state.apply(&Command::AddCursorBelow);
    type_text(&mut state, "\n  ");
    assert_same_as_fresh_parse(&state, "a.ts");
    state.apply(&Command::Delete { motion: Motion::Left });
    state.apply(&Command::Delete { motion: Motion::Left });
    assert_same_as_fresh_parse(&state, "a.ts");
    state.apply(&Command::SelectAll);
    type_text(&mut state, "const z = [1, 2];\n");
    assert_same_as_fresh_parse(&state, "a.ts");
}

#[test]
fn a_svelte_script_is_highlighted_as_javascript_and_stays_right_while_typing() {
    let source = "<script lang=\"ts\">\n  const answer: number = 42;\n</script>\n\n<h1>{answer}</h1>\n\n<style>\n  h1 { color: red; }\n</style>\n";
    let mut state = state_named("App.svelte", source);
    assert!(has(&state, 1, "const", "keyword"));
    assert!(has(&state, 1, "number", "type.builtin"));
    assert!(has(&state, 7, "color", "property"));
    state.apply(&Command::PlaceCursor { at: at(1, 2) });
    type_text(&mut state, "let one = 1;\n  ");
    assert!(has(&state, 1, "let", "keyword"));
    assert!(has(&state, 2, "const", "keyword"));
    assert_same_as_fresh_parse(&state, "App.svelte");
    // Typing outside the script leaves the script's colours alone.
    state.apply(&Command::PlaceCursor { at: at(6, 0) });
    type_text(&mut state, "<p>hi</p>\n");
    assert!(has(&state, 1, "let", "keyword"));
    assert_same_as_fresh_parse(&state, "App.svelte");
}

#[test]
fn markdown_fences_are_highlighted_in_their_language() {
    let source = "# Title\n\nSome *emphasis* here.\n\n```rust\nfn main() {}\n```\n";
    let mut state = state_named("a.md", source);
    assert!(has(&state, 5, "fn", "keyword"));
    assert!(!has(&state, 5, " ", "text.literal"));
    assert!(has(&state, 2, "emphasis", "emphasis"));
    state.apply(&Command::PlaceCursor { at: at(5, 0) });
    type_text(&mut state, "pub ");
    assert!(has(&state, 5, "pub", "keyword"));
    assert_same_as_fresh_parse(&state, "a.md");
}

/// Run with `cargo test -p editor-core --release -- --ignored --nocapture` to see the timings.
#[test]
#[ignore]
fn reparsing_a_large_file_is_fast() {
    let function = "pub fn compute(first: usize, second: &str) -> Result<Vec<String>, Error> {\n    let mut out = Vec::new();\n    for index in 0..first {\n        out.push(format!(\"{second}{index}\")); // push\n    }\n    Ok(out)\n}\n\n";
    let text = function.repeat(10_000 / 8);
    let started = Instant::now();
    let mut state = state_named("big.rs", &text);
    println!("open and first parse of {} lines: {:?}", state.buffer().line_count(), started.elapsed());
    state.apply(&Command::PlaceCursor { at: at(5000, 4) });
    let mut worst = std::time::Duration::ZERO;
    let mut total = std::time::Duration::ZERO;
    let keystrokes = 200;
    for _ in 0..keystrokes {
        let started = Instant::now();
        type_text(&mut state, "x");
        let took = started.elapsed();
        worst = worst.max(took);
        total += took;
    }
    println!("{keystrokes} keystrokes in the middle: mean {:?}, worst {:?}", total / keystrokes, worst);
    let started = Instant::now();
    let rows = state.highlights(5000..5060);
    println!(
        "highlights of 60 visible rows: {:?} ({} spans)",
        started.elapsed(),
        rows.iter().map(Vec::len).sum::<usize>()
    );
    let started = Instant::now();
    state.highlights(0..60);
    println!("highlights of the first 60 rows: {:?}", started.elapsed());
}

/// Markdown is the costliest case, with a layer for every paragraph.
#[test]
#[ignore]
fn reparsing_a_large_markdown_file_is_fast() {
    let section = "## Heading\n\nSome *emphasis* and `code` in a paragraph with a [link](http://example.com).\n\n```rust\nfn main() {}\n```\n\n- one\n- two\n\n";
    let text = section.repeat(1000);
    let started = Instant::now();
    let mut state = state_named("big.md", &text);
    println!("markdown: open and first parse of {} lines: {:?}", state.buffer().line_count(), started.elapsed());
    state.apply(&Command::PlaceCursor { at: at(5000, 3) });
    let mut worst = std::time::Duration::ZERO;
    let mut total = std::time::Duration::ZERO;
    for _ in 0..100 {
        let started = Instant::now();
        type_text(&mut state, "x");
        let took = started.elapsed();
        worst = worst.max(took);
        total += took;
    }
    println!("markdown: 100 keystrokes: mean {:?}, worst {:?}", total / 100, worst);
}
