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
