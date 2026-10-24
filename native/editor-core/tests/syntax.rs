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
        ("Cargo.toml", "toml"),
        ("ci.yaml", "yaml"),
        ("ci.yml", "yaml"),
        ("main.py", "python"),
        ("main.pyi", "python"),
        ("main.c", "c"),
        ("main.h", "c"),
        ("main.cpp", "cpp"),
        ("main.cc", "cpp"),
        ("main.cxx", "cpp"),
        ("main.hpp", "cpp"),
        ("main.hh", "cpp"),
        ("Dockerfile", "dockerfile"),
        ("build.dockerfile", "dockerfile"),
        ("Containerfile", "dockerfile"),
        ("schema.sql", "sql"),
        ("schema.surql", "surrealql"),
        ("Makefile", "make"),
        ("makefile", "make"),
        ("GNUmakefile", "make"),
        ("rules.mk", "make"),
        ("CMakeLists.txt", "cmake"),
        ("FindThing.cmake", "cmake"),
        ("theme.scss", "scss"),
        ("data.xml", "xml"),
        ("logo.svg", "xml"),
        ("Info.plist", "xml"),
        ("types.xsd", "xml"),
        (".gitignore", "gitignore"),
        (".dockerignore", "gitignore"),
        (".ignore", "gitignore"),
        (".prettierignore", "gitignore"),
        (".npmignore", "gitignore"),
        ("config.fish", "fish"),
        ("run.bash", "bash"),
        (".bash_profile", "bash"),
        (".profile", "bash"),
        ("Taskfile.yml", "yaml"),
        ("Taskfile.yaml", "yaml"),
        ("Taskfile.dist.yml", "yaml"),
    ];
    for (path, language) in names {
        let found = language_for_path(Path::new(path));
        assert_eq!(found.map(|found| found.name), Some(language), "{path}");
    }
    assert!(language_for_path(Path::new("notes.txt")).is_none());
}

#[test]
fn code_fences_find_languages_by_name_and_alias() {
    assert_eq!(language_for_name("ts").map(|language| language.name), Some("typescript"));
    assert_eq!(language_for_name("py").map(|language| language.name), Some("python"));
    assert_eq!(language_for_name("c++").map(|language| language.name), Some("cpp"));
    assert_eq!(language_for_name("yml").map(|language| language.name), Some("yaml"));
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

/// Asserts that a sample, written to a file of the given name, has each text coloured as the
/// highlight it is listed with, on the given row.
fn assert_highlighted(name: &str, text: &str, expected: &[(usize, &str, &str)]) {
    let state = state_named(name, text);
    for (row, piece, highlight) in expected {
        assert!(
            has(&state, *row, piece, highlight),
            "{name} row {row}: {piece} as {highlight} in {:?}",
            pieces(&state, *row)
        );
    }
}

#[test]
fn toml_is_highlighted() {
    let text = "# manifest\n[package]\nname = \"grove\"\nedition = 2024\npublish = false\n";
    assert_highlighted(
        "Cargo.toml",
        text,
        &[
            (0, "# manifest", "comment"),
            (1, "package", "type"),
            (2, "\"grove\"", "string"),
            (3, "2024", "number"),
            (4, "false", "boolean"),
        ],
    );
}

#[test]
fn yaml_is_highlighted() {
    let text = "# settings\nname: grove\nreplicas: 3\nenabled: true\nimage: \"grove:latest\"\n";
    assert_highlighted(
        "ci.yml",
        text,
        &[
            (0, "# settings", "comment"),
            (1, "name", "property"),
            (1, "grove", "string"),
            (2, "3", "number"),
            (3, "true", "boolean"),
            (4, "\"grove:latest\"", "string"),
        ],
    );
}

#[test]
fn python_is_highlighted() {
    let text = "# count\nimport re\n\ndef main(limit: int) -> None:\n    print(\"hi\", 2.5, True)\n";
    assert_highlighted(
        "main.py",
        text,
        &[
            (0, "# count", "comment"),
            (1, "import", "keyword"),
            (3, "def", "keyword"),
            (3, "main", "function"),
            (3, "int", "type"),
            (4, "print", "function.builtin"),
            (4, "\"hi\"", "string"),
            (4, "2.5", "number"),
            (4, "True", "constant.builtin"),
        ],
    );
}

#[test]
fn c_is_highlighted() {
    let text = "#include <stdio.h>\n/* sums */\nstatic int sum(void) { return 0x10; }\nbool done = true;\n";
    assert_highlighted(
        "main.c",
        text,
        &[
            (0, "#include", "keyword"),
            (1, "/* sums */", "comment"),
            (2, "static", "keyword"),
            (2, "int", "type"),
            (2, "sum", "function"),
            (2, "return", "keyword"),
            (2, "0x10", "number"),
            (3, "true", "boolean"),
        ],
    );
}

#[test]
fn cpp_is_highlighted_with_the_c_queries_under_it() {
    let text = "// bag\nnamespace grove {\nclass Bag : public Base {\n    int size() const { return 1; }\n    std::string label = \"bag\";\n};\n}\n";
    assert_highlighted(
        "main.cpp",
        text,
        &[
            (0, "// bag", "comment"),
            (1, "namespace", "keyword"),
            (1, "grove", "module"),
            (2, "class", "keyword"),
            (2, "Bag", "type"),
            (3, "int", "type"),
            (3, "return", "keyword"),
            (3, "1", "number"),
            (4, "\"bag\"", "string"),
        ],
    );
}

#[test]
fn dockerfile_is_highlighted_and_its_shell_is_embedded() {
    let text = "# build\nFROM node:22 AS build\nENV PORT=3000\nRUN npm install && echo \"done\"\nEXPOSE 3000\n";
    assert_highlighted(
        "Dockerfile",
        text,
        &[
            (0, "# build", "comment"),
            (1, "FROM", "keyword"),
            (2, "PORT", "property"),
            (3, "RUN", "keyword"),
            (3, "npm", "function"),
            (4, "3000", "number"),
        ],
    );
}

#[test]
fn sql_is_highlighted_and_numbers_are_not_strings() {
    let text = "-- orders\nSELECT name, COUNT(id) FROM users WHERE age > 18 AND city = 'Berlin' LIMIT 1.5;\n";
    assert_highlighted(
        "schema.sql",
        text,
        &[
            (0, "-- orders", "comment"),
            (1, "SELECT", "keyword"),
            (1, "COUNT", "function"),
            (1, "FROM", "keyword"),
            (1, "18", "number"),
            (1, "'Berlin'", "string"),
            (1, "1.5", "number"),
        ],
    );
}

#[test]
fn surrealql_is_highlighted() {
    let text = "-- people\nDEFINE FIELD age ON person TYPE int;\nCREATE person SET name = 'Tobie', age = 42, active = true;\nLET $limit = 10;\n";
    assert_highlighted(
        "schema.surql",
        text,
        &[
            (0, "-- people", "comment"),
            (1, "DEFINE", "keyword"),
            (1, "int", "type"),
            (2, "'Tobie'", "string"),
            (2, "42", "number"),
            (2, "true", "boolean"),
            (3, "$limit", "variable.builtin"),
        ],
    );
}

#[test]
fn make_is_highlighted() {
    let text = "# build\nCC := gcc\nall: app\n\t@echo $(CC)\nifeq ($(DEBUG),1)\nendif\n";
    assert_highlighted(
        "Makefile",
        text,
        &[(0, "# build", "comment"), (1, "CC", "constant.builtin"), (2, "all", "constant"), (4, "ifeq", "keyword")],
    );
}

#[test]
fn cmake_is_highlighted_with_its_patterns_as_regular_expressions() {
    let text = "# project\nproject(grove LANGUAGES CXX)\nif(ON)\nendif()\n";
    assert_highlighted(
        "CMakeLists.txt",
        text,
        &[
            (0, "# project", "comment"),
            (1, "project", "function.builtin"),
            (1, "LANGUAGES", "constant"),
            (2, "if", "keyword"),
        ],
    );
}

#[test]
fn scss_is_highlighted_with_the_css_queries_under_it() {
    let text = "// theme\n$gap: 8px;\n.card {\n  @include card(6px);\n  color: \"red\";\n}\n";
    assert_highlighted(
        "theme.scss",
        text,
        &[
            (0, "// theme", "comment"),
            (1, "$gap", "property"),
            (1, "8", "number"),
            (3, "@include", "keyword"),
            (4, "color", "property"),
            (4, "\"red\"", "string"),
        ],
    );
}

#[test]
fn xml_is_highlighted() {
    let text = "<!-- list -->\n<book id=\"42\">Grove &amp; Trees</book>\n";
    assert_highlighted(
        "data.svg",
        text,
        &[
            (0, "<!-- list -->", "comment"),
            (1, "book", "tag"),
            (1, "id", "property"),
            (1, "42", "string"),
            (1, "&amp;", "constant.builtin"),
        ],
    );
}

#[test]
fn gitignore_is_highlighted_from_the_vendored_grammar() {
    let text = "# output\n/target/\n*.log\n!keep.log\n";
    assert_highlighted(
        ".gitignore",
        text,
        &[
            (0, "# output", "comment"),
            (1, "/", "punctuation.delimiter"),
            (1, "target", "string"),
            (2, "*", "operator"),
            (3, "!", "operator"),
        ],
    );
}

#[test]
fn fish_is_highlighted() {
    let text = "# greet\nfunction greet\n    echo \"hi $name\"\nend\n";
    assert_highlighted(
        "config.fish",
        text,
        &[
            (0, "# greet", "comment"),
            (1, "function", "keyword"),
            (1, "greet", "function"),
            (2, "echo", "function"),
            (3, "end", "keyword"),
        ],
    );
}

#[test]
fn a_shebang_names_the_language_of_a_file_without_an_extension() {
    let cases = [
        ("#!/bin/bash\necho hi\n", "bash"),
        ("#!/bin/sh\necho hi\n", "bash"),
        ("#!/usr/bin/env bash\necho hi\n", "bash"),
        ("#!/usr/bin/env -S bash -e\necho hi\n", "bash"),
        ("#!/usr/bin/python3\nprint(1)\n", "python"),
        ("#!/usr/bin/env fish\necho hi\n", "fish"),
    ];
    for (text, language) in cases {
        let state = state_named("deploy", text);
        assert_eq!(state.language_name(), Some(language), "{text}");
    }
    assert_eq!(state_named("deploy", "echo hi\n").language_name(), None);
    assert_eq!(state_named("deploy", "#!/usr/bin/env node\n").language_name(), None);
    assert_eq!(state_named("notes.md", "#!/bin/bash\n").language_name(), Some("markdown"));
}

#[test]
fn markdown_fences_highlight_the_new_languages() {
    let state = state_named("a.md", "```python\ndef main():\n    pass\n```\n");
    assert!(has(&state, 1, "def", "keyword"));
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
