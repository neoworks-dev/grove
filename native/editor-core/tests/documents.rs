//! The document store: one document per file, shared state, and the modified state it reports.

use std::path::PathBuf;

use editor_core::{Command, Documents, Position};

/// A file with some text in a directory of its own, so tests do not share files.
fn file_with(name: &str, text: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("editor-core-documents-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn type_text(documents: &mut Documents, id: u64, text: &str) {
    documents.apply(id, &Command::InsertText { text: text.to_string() }).unwrap();
}

fn text_of(documents: &Documents, id: u64) -> String {
    let buffer = documents.get(id).unwrap().state.buffer();
    buffer.slice(0..buffer.length())
}

#[test]
fn opening_a_file_twice_gives_the_same_document() {
    let path = file_with("twice.rs", "one\n");
    let mut documents = Documents::new();
    let first = documents.open(&path).unwrap();
    let second = documents.open(&path).unwrap();
    assert_eq!(first.id, second.id);
    assert!(first.created);
    assert!(!second.created);
    assert_eq!(documents.summaries().len(), 1);
}

#[test]
fn reopening_keeps_unsaved_edits() {
    let path = file_with("keeps.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    type_text(&mut documents, id, "EDIT ");
    documents.open(&path).unwrap();
    assert_eq!(text_of(&documents, id), "EDIT one\n");
}

#[test]
fn a_path_reached_through_a_symlink_is_the_same_document() {
    let path = file_with("target.rs", "one\n");
    let link = path.with_file_name("link.rs");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let mut documents = Documents::new();
    let first = documents.open(&path).unwrap().id;
    let second = documents.open(&link).unwrap().id;
    assert_eq!(first, second);
}

#[test]
fn different_files_get_different_ids_in_opening_order() {
    let mut documents = Documents::new();
    let first = documents.open(&file_with("a.rs", "a")).unwrap().id;
    let second = documents.open(&file_with("b.rs", "b")).unwrap().id;
    assert_ne!(first, second);
    let titles: Vec<String> = documents.summaries().into_iter().map(|summary| summary.title).collect();
    assert_eq!(titles, vec!["a.rs", "b.rs"]);
}

#[test]
fn opening_a_missing_file_fails_and_adds_nothing() {
    let mut documents = Documents::new();
    assert!(documents.open(&std::env::temp_dir().join("editor-core-no-such-file.rs")).is_err());
    assert!(documents.summaries().is_empty());
}

#[test]
fn closing_removes_the_document_and_never_reuses_its_id() {
    let path = file_with("close.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    assert!(documents.close(id));
    assert!(!documents.close(id));
    assert!(documents.get(id).is_none());
    assert_ne!(documents.open(&path).unwrap().id, id);
}

#[test]
fn editing_reports_the_modified_state_once_per_change() {
    let path = file_with("dirty.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    let first = documents.apply(id, &Command::InsertText { text: "x".into() }).unwrap();
    assert_eq!(first.modified_changed, Some(true));
    let second = documents.apply(id, &Command::InsertText { text: "y".into() }).unwrap();
    assert_eq!(second.modified_changed, None);
    assert!(documents.summaries()[0].dirty);
}

#[test]
fn saving_clears_the_dirty_state_and_writes_the_file() {
    let path = file_with("save.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    type_text(&mut documents, id, "EDIT ");
    let saved = documents.apply(id, &Command::Save).unwrap();
    assert!(saved.outcome.saved);
    assert_eq!(saved.modified_changed, Some(false));
    assert!(!documents.summaries()[0].dirty);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "EDIT one\n");
}

#[test]
fn undoing_back_to_the_saved_text_is_not_dirty() {
    let path = file_with("undo.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    type_text(&mut documents, id, "x");
    let undone = documents.apply(id, &Command::Undo).unwrap();
    assert_eq!(undone.modified_changed, Some(false));
}

#[test]
fn selections_belong_to_the_document() {
    let path = file_with("cursor.rs", "one\ntwo\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    documents.apply(id, &Command::PlaceCursor { at: Position { row: 1, column: 2 } });
    let reopened = documents.open(&path).unwrap().id;
    let newest = documents.get(reopened).unwrap().state.selections().newest();
    assert_eq!(newest.head, Position { row: 1, column: 2 });
}

#[test]
fn applying_to_a_closed_document_does_nothing() {
    let mut documents = Documents::new();
    assert!(documents.apply(7, &Command::Undo).is_none());
}

#[test]
fn an_untitled_document_has_no_path() {
    let mut documents = Documents::new();
    let id = documents.open_untitled("hello");
    let summary = documents.get(id).unwrap().summary();
    assert_eq!(summary.path, None);
    assert_eq!(summary.title, "Untitled");
}

#[test]
fn vim_registers_are_shared_between_documents() {
    use editor_core::Motion;
    use editor_core::vim::types::{Operator, Target};
    let mut documents = Documents::new();
    let first = documents.open_untitled("one two");
    let second = documents.open_untitled("other");
    let yank_word = Command::Operate {
        operator: Operator::Yank,
        target: Target::Motion { motion: Motion::WordForward { big: false }, count: 1 },
        register: None,
    };
    documents.apply(first, &yank_word).unwrap();
    let put = Command::Put { register: None, before: true, count: 1, cursor_after: false, over: None, clipboard: None };
    documents.apply(second, &put).unwrap();
    assert_eq!(text_of(&documents, second), "one other");
}

#[test]
fn a_new_default_indent_reaches_only_files_that_did_not_say() {
    use editor_core::IndentStyle;
    let plain = file_with("plain.txt", "one\ntwo\n");
    let indented = file_with("indented.ts", "a {\n  b;\n}\n");
    let chosen = file_with("chosen.txt", "x\n");
    let mut documents = Documents::new();
    let plain_id = documents.open(&plain).unwrap().id;
    let indented_id = documents.open(&indented).unwrap().id;
    let chosen_id = documents.open(&chosen).unwrap().id;
    documents.apply(chosen_id, &Command::SetIndent { style: IndentStyle::Tabs }).unwrap();

    let changed = documents.set_default_indent(IndentStyle::Spaces { width: 8 });
    assert_eq!(changed, vec![plain_id]);
    let indent_of = |documents: &Documents, id| documents.get(id).unwrap().summary().indent;
    assert_eq!(indent_of(&documents, plain_id), IndentStyle::Spaces { width: 8 });
    assert_eq!(indent_of(&documents, indented_id), IndentStyle::Spaces { width: 2 });
    assert_eq!(indent_of(&documents, chosen_id), IndentStyle::Tabs);

    let later = file_with("later.txt", "z\n");
    let later_id = documents.open(&later).unwrap().id;
    assert_eq!(indent_of(&documents, later_id), IndentStyle::Spaces { width: 8 });
}

#[test]
fn detached_text_is_highlighted_by_its_name_but_has_no_file_to_find_or_save() {
    let path = file_with("real.rs", "fn main() {}\n");
    let mut documents = Documents::new();
    let detached = documents.open_detached("fn old() {}\n", &path);
    assert_eq!(documents.get(detached).unwrap().state.language_name(), Some("rust"));
    let summary = documents.get(detached).unwrap().summary();
    assert_eq!(summary.path, None);
    assert_eq!(summary.title, "real.rs");
    let opened = documents.open(&path).unwrap();
    assert!(opened.created);
    assert_ne!(opened.id, detached);
    let saved = documents.apply(detached, &Command::Save).unwrap();
    assert!(saved.outcome.error.is_some());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "fn main() {}\n");
}

#[test]
fn detached_text_can_be_replaced_but_a_files_document_cannot() {
    let path = file_with("replace.rs", "one\n");
    let mut documents = Documents::new();
    let detached = documents.open_detached("old\n", &path);
    assert!(documents.replace_detached_text(detached, "new\n"));
    assert_eq!(text_of(&documents, detached), "new\n");
    let real = documents.open(&path).unwrap().id;
    assert!(!documents.replace_detached_text(real, "x"));
    assert!(!documents.replace_detached_text(99, "x"));
}

#[test]
fn reloading_reads_the_file_again_and_forgets_the_edits() {
    let path = file_with("reload.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    type_text(&mut documents, id, "X");
    std::fs::write(&path, "two\n").unwrap();
    documents.reload(id).unwrap();
    assert_eq!(text_of(&documents, id), "two\n");
    assert!(!documents.get(id).unwrap().state.is_modified());
    assert!(documents.reload(99).is_err());
}

#[test]
fn syncing_takes_the_new_text_and_keeps_the_cursor_and_history() {
    let path = file_with("sync.rs", "one\ntwo\nthree\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    documents.apply(id, &Command::PlaceCursor { at: Position { row: 2, column: 2 } }).unwrap();
    std::fs::write(&path, "one\nTWO and more\nthree\n").unwrap();

    assert!(documents.sync_with_disk(id).unwrap());
    assert_eq!(text_of(&documents, id), "one\nTWO and more\nthree\n");
    let state = &documents.get(id).unwrap().state;
    assert!(!state.is_modified());
    assert_eq!(state.selections().newest().head, Position { row: 2, column: 2 });

    documents.apply(id, &Command::Undo).unwrap();
    assert_eq!(text_of(&documents, id), "one\ntwo\nthree\n");
}

#[test]
fn syncing_an_unchanged_file_does_nothing() {
    let path = file_with("same.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    assert!(!documents.sync_with_disk(id).unwrap());
}

#[test]
fn syncing_leaves_unsaved_edits_alone() {
    let path = file_with("unsaved.rs", "one\n");
    let mut documents = Documents::new();
    let id = documents.open(&path).unwrap().id;
    type_text(&mut documents, id, "X");
    std::fs::write(&path, "two\n").unwrap();
    assert!(!documents.sync_with_disk(id).unwrap());
    assert_eq!(text_of(&documents, id), "Xone\n");
}
