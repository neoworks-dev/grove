//! Editing through `EditorState::apply`, the way a key or Svelte reaches it: text, multiple
//! cursors, undo, anchors, the clipboard and saving.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use editor_core::history::COALESCE_PAUSE;
use editor_core::{Bias, Buffer, Command, EditorState, Motion, Position, Selection};

fn at(row: usize, column: usize) -> Position {
    Position { row, column }
}

/// A state over some text with a cursor at each position.
fn state_with_cursors(text: &str, cursors: &[Position]) -> EditorState {
    let mut state = EditorState::new(Buffer::from_text(text));
    state.apply(&Command::PlaceCursor { at: cursors[0] });
    for cursor in &cursors[1..] {
        state.apply(&Command::ToggleCursor { at: *cursor });
    }
    state
}

/// The whole text of the state's buffer.
fn text_of(state: &EditorState) -> String {
    state.buffer().slice(0..state.buffer().length())
}

fn heads(state: &EditorState) -> Vec<Position> {
    state.selections().all().iter().map(|selection| selection.head).collect()
}

fn type_text(state: &mut EditorState, text: &str) {
    state.apply(&Command::InsertText { text: text.to_string() });
}

fn backspace() -> Command {
    Command::Delete { motion: Motion::Left }
}

fn delete_forward() -> Command {
    Command::Delete { motion: Motion::Right }
}

/// A file path in the temp directory that nothing else uses.
fn temp_path(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("editor-core-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join(name)
}

#[test]
fn typing_inserts_at_every_cursor_and_moves_them_past_it() {
    let mut state = state_with_cursors("one\ntwo\nthree", &[at(0, 3), at(1, 0), at(2, 2)]);
    type_text(&mut state, "X");
    assert_eq!(text_of(&state), "oneX\nXtwo\nthXree");
    assert_eq!(heads(&state), vec![at(0, 4), at(1, 1), at(2, 3)]);
    type_text(&mut state, "yz");
    assert_eq!(text_of(&state), "oneXyz\nXyztwo\nthXyzree");
}

#[test]
fn several_cursors_on_one_line_do_not_use_stale_positions() {
    let mut state = state_with_cursors("abcdef", &[at(0, 1), at(0, 3), at(0, 5)]);
    type_text(&mut state, "--");
    assert_eq!(text_of(&state), "a--bc--de--f");
    assert_eq!(heads(&state), vec![at(0, 3), at(0, 7), at(0, 11)]);
}

#[test]
fn typing_replaces_selected_text() {
    let mut state = state_with_cursors("foo bar foo", &[at(0, 0)]);
    state.apply(&Command::SelectNextOccurrence);
    state.apply(&Command::SelectNextOccurrence);
    assert_eq!(state.selections().count(), 2);
    type_text(&mut state, "quux");
    assert_eq!(text_of(&state), "quux bar quux");
    assert_eq!(heads(&state), vec![at(0, 4), at(0, 13)]);
    assert!(state.selections().all().iter().all(Selection::is_empty));
}

#[test]
fn backspace_deletes_a_character_before_each_cursor() {
    let mut state = state_with_cursors("abc\ndef", &[at(0, 2), at(1, 3)]);
    state.apply(&backspace());
    assert_eq!(text_of(&state), "ac\nde");
    assert_eq!(heads(&state), vec![at(0, 1), at(1, 2)]);
}

#[test]
fn backspace_at_a_line_start_joins_the_lines() {
    let mut state = state_with_cursors("ab\ncd\nef", &[at(1, 0), at(2, 0)]);
    state.apply(&backspace());
    assert_eq!(text_of(&state), "abcdef");
    assert_eq!(heads(&state), vec![at(0, 2), at(0, 4)]);
}

#[test]
fn backspace_at_the_start_of_the_buffer_does_nothing() {
    let mut state = state_with_cursors("ab", &[at(0, 0)]);
    let outcome = state.apply(&backspace());
    assert!(!outcome.changed);
    assert!(!state.is_modified());
}

#[test]
fn cursors_that_delete_into_each_other_merge() {
    let mut state = state_with_cursors("abc", &[at(0, 1), at(0, 2)]);
    state.apply(&backspace());
    assert_eq!(text_of(&state), "c");
    assert_eq!(state.selections().count(), 1);
}

#[test]
fn delete_removes_the_character_after_each_cursor_and_joins_at_line_ends() {
    let mut state = state_with_cursors("abc\ndef", &[at(0, 0), at(0, 3)]);
    state.apply(&delete_forward());
    assert_eq!(text_of(&state), "bcdef");
    assert_eq!(heads(&state), vec![at(0, 0), at(0, 2)]);
}

#[test]
fn deleting_with_a_selection_removes_it_and_keeps_the_rest() {
    let mut state = state_with_cursors("one two three", &[at(0, 3)]);
    state.apply(&Command::MoveSelections { motion: Motion::LineEnd, extend: true });
    state.apply(&backspace());
    assert_eq!(text_of(&state), "one");
    assert_eq!(heads(&state), vec![at(0, 3)]);
}

#[test]
fn enter_keeps_each_lines_indentation() {
    let mut state = state_with_cursors("  ab\n\tcd\nef", &[at(0, 4), at(1, 3), at(2, 1)]);
    state.apply(&Command::InsertNewline);
    assert_eq!(text_of(&state), "  ab\n  \n\tcd\n\t\ne\nf");
    assert_eq!(heads(&state), vec![at(1, 2), at(3, 1), at(5, 0)]);
}

#[test]
fn enter_in_the_indentation_copies_only_what_is_before_the_cursor() {
    let mut state = state_with_cursors("    x", &[at(0, 2)]);
    state.apply(&Command::InsertNewline);
    assert_eq!(text_of(&state), "  \n    x");
}

#[test]
fn enter_replaces_a_selection() {
    let mut state = state_with_cursors("ab cd", &[at(0, 2)]);
    state.apply(&Command::MoveSelections { motion: Motion::Right, extend: true });
    state.apply(&Command::InsertNewline);
    assert_eq!(text_of(&state), "ab\ncd");
}

#[test]
fn tab_reaches_the_next_tab_stop() {
    let mut state = state_with_cursors("ab\nabcd", &[at(0, 2), at(1, 4)]);
    state.apply(&Command::InsertTab);
    assert_eq!(text_of(&state), "ab  \nabcd    ");
}

#[test]
fn tab_is_a_tab_in_a_file_indented_with_tabs() {
    let mut state = state_with_cursors("fn x() {\n\ta;\n\tb;\n}", &[at(3, 0)]);
    state.apply(&Command::InsertTab);
    assert_eq!(state.buffer().line(3), "\t}");
}

#[test]
fn anchors_keep_their_place_through_edits() {
    let mut state = state_with_cursors("let value = 1;", &[at(0, 0)]);
    let word_start = state.create_anchor(at(0, 4), Bias::Left);
    let word_end = state.create_anchor(at(0, 9), Bias::Right);
    type_text(&mut state, "pub ");
    assert_eq!(state.anchor_position(word_start), Some(at(0, 8)));
    assert_eq!(state.anchor_position(word_end), Some(at(0, 13)));
    state.apply(&Command::PlaceCursor { at: at(0, 99) });
    type_text(&mut state, " // note");
    assert_eq!(state.anchor_position(word_start), Some(at(0, 8)));
}

#[test]
fn anchors_follow_lines_that_are_added_above_them() {
    let mut state = state_with_cursors("a\nb\nc", &[at(0, 1)]);
    let anchor = state.create_anchor(at(2, 1), Bias::Left);
    state.apply(&Command::InsertNewline);
    state.apply(&Command::InsertNewline);
    assert_eq!(state.anchor_position(anchor), Some(at(4, 1)));
}

#[test]
fn bias_decides_what_an_insertion_exactly_at_an_anchor_does() {
    let mut state = state_with_cursors("abc", &[at(0, 1)]);
    let left = state.create_anchor(at(0, 1), Bias::Left);
    let right = state.create_anchor(at(0, 1), Bias::Right);
    type_text(&mut state, "XY");
    assert_eq!(state.anchor_position(left), Some(at(0, 1)));
    assert_eq!(state.anchor_position(right), Some(at(0, 3)));
}

#[test]
fn anchors_in_deleted_text_collapse_to_the_deletion_and_stay_there_on_undo() {
    let mut state = state_with_cursors("abcdef", &[at(0, 2)]);
    let anchor = state.create_anchor(at(0, 4), Bias::Left);
    state.apply(&Command::ExtendNewestTo { at: at(0, 6) });
    state.apply(&backspace());
    assert_eq!(text_of(&state), "ab");
    assert_eq!(state.anchor_position(anchor), Some(at(0, 2)));
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "abcdef");
    assert_eq!(state.anchor_position(anchor), Some(at(0, 2)));
}

#[test]
fn removed_anchors_are_forgotten() {
    let mut state = state_with_cursors("abc", &[at(0, 1)]);
    let anchor = state.create_anchor(at(0, 1), Bias::Left);
    state.remove_anchor(anchor);
    assert_eq!(state.anchor_position(anchor), None);
}

#[test]
fn undo_restores_the_text_and_the_cursors_and_redo_does_it_again() {
    let original = "one\ntwo\nthree";
    let mut state = state_with_cursors(original, &[at(0, 3), at(1, 0), at(2, 2)]);
    let cursors_before = state.selections().clone();
    state.apply(&Command::InsertNewline);
    let after = text_of(&state);
    let cursors_after = state.selections().clone();
    assert_ne!(after, original);

    assert!(state.apply(&Command::Undo).changed);
    assert_eq!(text_of(&state), original);
    assert_eq!(state.selections(), &cursors_before);

    assert!(state.apply(&Command::Redo).changed);
    assert_eq!(text_of(&state), after);
    assert_eq!(state.selections(), &cursors_after);
}

#[test]
fn undo_with_nothing_to_undo_changes_nothing() {
    let mut state = state_with_cursors("abc", &[at(0, 0)]);
    assert!(!state.apply(&Command::Undo).changed);
    assert!(!state.apply(&Command::Redo).changed);
}

#[test]
fn every_edit_command_is_one_undo_step() {
    let mut state = state_with_cursors("ab\ncd", &[at(0, 2), at(1, 2)]);
    let mut texts = vec![text_of(&state)];
    for command in [Command::InsertNewline, Command::InsertTab, backspace()] {
        state.apply(&command);
        texts.push(text_of(&state));
    }
    assert_eq!(texts, vec!["ab\ncd", "ab\n\ncd\n", "ab\n    \ncd\n    ", "ab\n   \ncd\n   "]);
    for expected in texts.iter().rev().skip(1) {
        state.apply(&Command::Undo);
        assert_eq!(&text_of(&state), expected);
    }
    assert!(!state.apply(&Command::Undo).changed);
}

#[test]
fn a_new_edit_clears_what_could_be_redone() {
    let mut state = state_with_cursors("abc", &[at(0, 0)]);
    type_text(&mut state, "x");
    state.apply(&Command::Undo);
    type_text(&mut state, "y");
    assert!(!state.apply(&Command::Redo).changed);
    assert_eq!(text_of(&state), "yabc");
}

#[test]
fn typed_characters_of_one_word_are_one_undo_step() {
    let mut state = state_with_cursors("", &[at(0, 0)]);
    let start = Instant::now();
    for (index, letter) in ["h", "e", "l", "l", "o"].iter().enumerate() {
        let command = Command::InsertText { text: letter.to_string() };
        state.apply_at(&command, start + Duration::from_millis(100 * index as u64));
    }
    assert_eq!(text_of(&state), "hello");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "");
    assert_eq!(heads(&state), vec![at(0, 0)]);
    state.apply(&Command::Redo);
    assert_eq!(text_of(&state), "hello");
    assert_eq!(heads(&state), vec![at(0, 5)]);
}

#[test]
fn typing_across_several_cursors_undoes_at_all_of_them() {
    let mut state = state_with_cursors("a\nb\nc", &[at(0, 1), at(1, 1), at(2, 1)]);
    type_text(&mut state, "x");
    type_text(&mut state, "y");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "a\nb\nc");
    assert_eq!(state.selections().count(), 3);
}

#[test]
fn whitespace_and_punctuation_start_new_steps() {
    let mut state = state_with_cursors("", &[at(0, 0)]);
    let now = Instant::now();
    for letter in "foo bar();".chars() {
        state.apply_at(&Command::InsertText { text: letter.to_string() }, now);
    }
    let mut steps = Vec::new();
    while state.apply(&Command::Undo).changed {
        steps.push(text_of(&state));
    }
    assert_eq!(steps, vec!["foo bar", "foo ", "foo", ""]);
}

#[test]
fn a_pause_starts_a_new_step() {
    let mut state = state_with_cursors("", &[at(0, 0)]);
    let start = Instant::now();
    state.apply_at(&Command::InsertText { text: "a".to_string() }, start);
    state.apply_at(&Command::InsertText { text: "b".to_string() }, start + COALESCE_PAUSE);
    state.apply_at(&Command::InsertText { text: "c".to_string() }, start + COALESCE_PAUSE * 3);
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "ab");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "");
}

#[test]
fn moving_the_cursor_starts_a_new_step() {
    let mut state = state_with_cursors("", &[at(0, 0)]);
    type_text(&mut state, "ab");
    state.apply(&Command::MoveSelections { motion: Motion::Left, extend: false });
    state.apply(&Command::MoveSelections { motion: Motion::Right, extend: false });
    type_text(&mut state, "cd");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "ab");
}

#[test]
fn other_edits_start_new_steps_and_are_not_joined() {
    let mut state = state_with_cursors("", &[at(0, 0)]);
    type_text(&mut state, "ab");
    state.apply(&backspace());
    type_text(&mut state, "c");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "a");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "ab");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "");
}

#[test]
fn typing_over_a_selection_is_a_step_of_its_own() {
    let mut state = state_with_cursors("hello", &[at(0, 0)]);
    state.apply(&Command::SelectNextOccurrence);
    type_text(&mut state, "j");
    type_text(&mut state, "k");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "j");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "hello");
}

#[test]
fn copy_joins_the_selections_with_line_breaks() {
    let mut state = state_with_cursors("one two\nthree four", &[at(0, 0)]);
    state.apply(&Command::ExtendNewestTo { at: at(0, 3) });
    state.apply(&Command::ToggleCursor { at: at(1, 6) });
    state.apply(&Command::ExtendNewestTo { at: at(1, 10) });
    let copied = state.apply(&Command::Copy).copied;
    assert_eq!(copied.as_deref(), Some("one\nfour"));
}

#[test]
fn copy_with_a_cursor_takes_the_whole_line() {
    let mut state = state_with_cursors("one\ntwo\nthree", &[at(1, 1)]);
    let copied = state.apply(&Command::Copy).copied;
    assert_eq!(copied.as_deref(), Some("two\n"));
}

#[test]
fn pasting_as_many_lines_as_cursors_puts_one_on_each() {
    let mut state = state_with_cursors("a:\nb:\nc:", &[at(0, 2), at(1, 2), at(2, 2)]);
    state.apply(&Command::Paste { text: "1\n2\n3".to_string() });
    assert_eq!(text_of(&state), "a:1\nb:2\nc:3");
    assert_eq!(heads(&state), vec![at(0, 3), at(1, 3), at(2, 3)]);
}

#[test]
fn pasting_another_number_of_lines_puts_all_of_it_at_each_cursor() {
    let mut state = state_with_cursors("a\nb", &[at(0, 1), at(1, 1)]);
    state.apply(&Command::Paste { text: "x\ny\nz".to_string() });
    assert_eq!(text_of(&state), "ax\ny\nz\nbx\ny\nz");
    assert_eq!(heads(&state), vec![at(2, 1), at(5, 1)]);
}

#[test]
fn pasting_replaces_the_selection_and_undoes_in_one_step() {
    let mut state = state_with_cursors("hello world", &[at(0, 0)]);
    state.apply(&Command::SelectNextOccurrence);
    state.apply(&Command::Paste { text: "bye".to_string() });
    assert_eq!(text_of(&state), "bye world");
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "hello world");
    assert!(!state.selections().newest().is_empty());
}

#[test]
fn cutting_selections_copies_and_deletes_them() {
    let mut state = state_with_cursors("ab cd ef", &[at(0, 0)]);
    state.apply(&Command::ExtendNewestTo { at: at(0, 1) });
    state.apply(&Command::ToggleCursor { at: at(0, 6) });
    state.apply(&Command::ExtendNewestTo { at: at(0, 7) });
    let outcome = state.apply(&Command::Cut);
    assert_eq!(outcome.copied.as_deref(), Some("a\ne"));
    assert_eq!(text_of(&state), "b cd f");
}

#[test]
fn cutting_with_cursors_takes_their_lines() {
    let mut state = state_with_cursors("one\ntwo\nthree\nfour", &[at(0, 1), at(2, 2)]);
    let outcome = state.apply(&Command::Cut);
    assert_eq!(outcome.copied.as_deref(), Some("one\nthree\n"));
    assert_eq!(text_of(&state), "two\nfour");
    assert_eq!(heads(&state), vec![at(0, 0), at(1, 0)]);
}

#[test]
fn pasting_copied_lines_puts_them_above_the_cursors_line() {
    let mut state = state_with_cursors("one\ntwo", &[at(0, 2)]);
    let copied = state.apply(&Command::Copy).copied.unwrap();
    state.apply(&Command::PlaceCursor { at: at(1, 1) });
    state.apply(&Command::Paste { text: copied });
    assert_eq!(text_of(&state), "one\none\ntwo");
    assert_eq!(heads(&state), vec![at(2, 1)]);
}

#[test]
fn saving_writes_the_text_and_clears_the_modified_state() {
    let path = temp_path("save.txt");
    std::fs::write(&path, "hello\n").unwrap();
    let mut state = EditorState::new(Buffer::open(&path).unwrap());
    assert!(!state.is_modified());
    state.apply(&Command::MoveSelections { motion: Motion::LineEnd, extend: false });
    type_text(&mut state, " world");
    assert!(state.is_modified());
    let outcome = state.apply(&Command::Save);
    assert!(outcome.saved);
    assert_eq!(outcome.error, None);
    assert!(!state.is_modified());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello world\n");
}

#[test]
fn undoing_back_to_the_saved_text_is_unmodified_and_past_it_is_modified() {
    let path = temp_path("undo-saved.txt");
    std::fs::write(&path, "x").unwrap();
    let mut state = EditorState::new(Buffer::open(&path).unwrap());
    type_text(&mut state, "a");
    state.apply(&Command::Save);
    state.apply(&Command::Undo);
    assert!(state.is_modified());
    state.apply(&Command::Redo);
    assert!(!state.is_modified());
    state.apply(&Command::Undo);
    state.apply(&Command::Undo);
    assert!(state.is_modified());
    assert_eq!(text_of(&state), "x");
}

#[test]
fn saving_keeps_the_files_line_endings() {
    let path = temp_path("crlf.txt");
    std::fs::write(&path, "one\r\ntwo\r\n").unwrap();
    let mut state = EditorState::new(Buffer::open(&path).unwrap());
    assert_eq!(state.buffer().line_count(), 3);
    state.apply(&Command::InsertNewline);
    state.apply(&Command::Save);
    assert_eq!(std::fs::read(&path).unwrap(), b"\r\none\r\ntwo\r\n");
}

#[test]
fn saving_a_buffer_without_a_file_fails_with_a_message() {
    let mut state = EditorState::new(Buffer::from_text("x"));
    let outcome = state.apply(&Command::Save);
    assert!(!outcome.saved);
    assert!(outcome.error.is_some());
}

#[test]
fn composed_text_is_marked_replaced_and_committed_as_one_undo_step() {
    let mut state = state_with_cursors("ab", &[at(0, 1)]);
    state.apply(&Command::SetMarkedText { text: "k".to_string() });
    assert_eq!(state.marked_range(), Some((at(0, 1), at(0, 2))));
    state.apply(&Command::SetMarkedText { text: "ka".to_string() });
    assert_eq!(text_of(&state), "akab");
    assert_eq!(state.marked_range(), Some((at(0, 1), at(0, 3))));
    state.apply(&Command::InsertText { text: "か".to_string() });
    assert_eq!(text_of(&state), "aかb");
    assert_eq!(state.marked_range(), None);
    assert_eq!(heads(&state), vec![at(0, 2)]);
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "ab");
    assert_eq!(heads(&state), vec![at(0, 1)]);
}

#[test]
fn replacing_a_range_puts_the_cursor_after_the_new_text() {
    let mut state = state_with_cursors("hello world", &[at(0, 11)]);
    state.apply(&Command::ReplaceRange { start: 0, end: 5, text: "bye".to_string() });
    assert_eq!(text_of(&state), "bye world");
    assert_eq!(heads(&state), vec![at(0, 3)]);
}

#[test]
fn utf16_offsets_count_characters_outside_the_basic_plane_twice() {
    let buffer = Buffer::from_text("a😀b");
    assert_eq!(buffer.utf16_of_offset(2), 3);
    assert_eq!(buffer.offset_of_utf16(3), 2);
}

#[test]
fn edit_commands_round_trip_through_json() {
    let commands = [
        Command::InsertText { text: "hi".to_string() },
        Command::Delete { motion: Motion::Left },
        Command::InsertNewline,
        Command::InsertTab,
        Command::Undo,
        Command::Redo,
        Command::Copy,
        Command::Cut,
        Command::Paste { text: "x".to_string() },
        Command::PasteClipboard,
        Command::Save,
        Command::SetMarkedText { text: "k".to_string() },
        Command::UnmarkText,
        Command::ReplaceRange { start: 1, end: 2, text: "z".to_string() },
    ];
    for command in commands {
        let json = serde_json::to_value(&command).unwrap();
        assert_eq!(serde_json::from_value::<Command>(json).unwrap(), command);
    }
    let command: Command = serde_json::from_str(r#"{"type": "insert_text", "text": "a"}"#).unwrap();
    assert_eq!(command, Command::InsertText { text: "a".to_string() });
}

fn edit(start: Position, end: Position, text: &str) -> editor_core::RangeEdit {
    editor_core::RangeEdit { start, end, text: text.to_string() }
}

#[test]
fn several_edits_apply_at_once_as_one_undo_step_and_cursors_keep_their_place() {
    let mut state = state_with_cursors("let a = 1;\nlet b = 2;\n", &[at(1, 9), at(0, 5)]);
    state.apply(&Command::ApplyEdits {
        edits: vec![
            edit(at(1, 4), at(1, 5), "bee"),
            edit(at(0, 4), at(0, 5), "ay"),
            edit(at(0, 0), at(0, 0), "// x\n"),
        ],
    });
    assert_eq!(text_of(&state), "// x\nlet ay = 1;\nlet bee = 2;\n");
    assert_eq!(heads(&state), vec![at(1, 4), at(2, 11)]);
    state.apply(&Command::Undo);
    assert_eq!(text_of(&state), "let a = 1;\nlet b = 2;\n");
}

#[test]
fn edits_that_change_nothing_leave_the_history_alone() {
    let mut state = state_with_cursors("same\n", &[at(0, 2)]);
    let outcome = state.apply(&Command::ApplyEdits { edits: vec![edit(at(0, 1), at(0, 1), "")] });
    assert!(!outcome.text_changed);
    assert!(!state.apply(&Command::Undo).text_changed);
}
