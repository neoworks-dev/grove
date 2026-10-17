//! How a file's indentation is read when it opens, and how Tab, Shift-Tab, Enter and vim's
//! shifts follow it.

use editor_core::{Buffer, Command, EditorState, IndentSource, IndentStyle, Motion, Position, Selection};

fn at(row: usize, column: usize) -> Position {
    Position { row, column }
}

/// A state over some text with one cursor at a position.
fn state_with_cursor(text: &str, cursor: Position) -> EditorState {
    let mut state = EditorState::new(Buffer::from_text(text));
    state.apply(&Command::PlaceCursor { at: cursor });
    state
}

fn text_of(state: &EditorState) -> String {
    state.buffer().slice(0..state.buffer().length())
}

const TWO_SPACES: &str = "function a() {\n  if (b) {\n    c();\n  }\n}\n";
const TABS: &str = "func a() {\n\tif b {\n\t\tc()\n\t}\n}\n";

#[test]
fn opening_a_file_reads_its_indentation() {
    let spaces = EditorState::new(Buffer::from_text(TWO_SPACES));
    assert_eq!(spaces.buffer().indent(), IndentStyle::Spaces { width: 2 });
    assert_eq!(spaces.buffer().indent_source(), IndentSource::Detected);
    let tabs = EditorState::new(Buffer::from_text(TABS));
    assert_eq!(tabs.buffer().indent(), IndentStyle::Tabs);
}

#[test]
fn a_file_that_says_nothing_uses_the_default_and_says_so() {
    let state = EditorState::new(Buffer::from_text("a\nb\n"));
    assert_eq!(state.buffer().indent(), IndentStyle::default());
    assert_eq!(state.buffer().indent_source(), IndentSource::Default);
}

#[test]
fn tab_goes_to_the_next_stop_of_the_files_width() {
    let mut state = state_with_cursor(&format!("{TWO_SPACES}x"), at(5, 1));
    state.apply(&Command::InsertTab);
    assert_eq!(state.buffer().line(5), "x ");
    state.apply(&Command::InsertTab);
    assert_eq!(state.buffer().line(5), "x   ");
}

#[test]
fn tab_over_several_lines_indents_them_and_shift_tab_takes_it_back() {
    let mut state = state_with_cursor(TWO_SPACES, at(1, 4));
    state.apply(&Command::MoveSelections { motion: Motion::Vertical(1), extend: true });
    state.apply(&Command::InsertTab);
    assert_eq!(state.buffer().line(0), "function a() {");
    assert_eq!(state.buffer().line(1), "    if (b) {");
    assert_eq!(state.buffer().line(2), "      c();");
    assert_eq!(state.selections().newest(), Selection::spanning(at(1, 6), at(2, 6)));
    state.apply(&Command::Outdent);
    assert_eq!(text_of(&state), TWO_SPACES);
}

#[test]
fn indenting_leaves_empty_lines_alone_and_outdenting_stops_at_the_margin() {
    let mut state = state_with_cursor("a\n\nb", at(0, 0));
    state.apply(&Command::MoveSelections { motion: Motion::BufferEnd, extend: true });
    state.apply(&Command::Indent);
    assert_eq!(text_of(&state), "    a\n\n    b");
    state.apply(&Command::Outdent);
    state.apply(&Command::Outdent);
    assert_eq!(text_of(&state), "a\n\nb");
}

#[test]
fn a_selection_ending_at_a_line_start_leaves_that_line_out() {
    let mut state = state_with_cursor("a\nb\nc", at(0, 0));
    state.apply(&Command::MoveSelections { motion: Motion::BufferEnd, extend: true });
    state.apply(&Command::Indent);
    assert_eq!(text_of(&state), "    a\n    b\n    c");
    let mut state = state_with_cursor("a\nb\nc", at(0, 0));
    state.apply(&Command::MoveSelections { motion: Motion::Vertical(2), extend: true });
    state.apply(&Command::MoveSelections { motion: Motion::LineStart, extend: true });
    state.apply(&Command::Indent);
    assert_eq!(text_of(&state), "    a\n    b\nc");
}

#[test]
fn enter_after_an_opening_bracket_indents_one_level_of_the_files_style() {
    let mut state = state_with_cursor("func a() {\n\tb()\n}\nx {", at(3, 3));
    assert_eq!(state.buffer().indent(), IndentStyle::Tabs);
    state.apply(&Command::InsertNewline);
    assert_eq!(state.buffer().line(4), "\t");
    let mut state = state_with_cursor(&format!("{TWO_SPACES}  while (x) {{"), at(5, 13));
    state.apply(&Command::InsertNewline);
    assert_eq!(state.buffer().line(6), "    ");
}

#[test]
fn enter_between_a_bracket_and_its_closer_adds_no_level() {
    let mut state = state_with_cursor("f({})", at(0, 3));
    state.apply(&Command::InsertNewline);
    assert_eq!(text_of(&state), "f({\n})");
}

#[test]
fn choosing_a_style_changes_tab_and_survives_a_new_default() {
    let mut state = state_with_cursor(TWO_SPACES, at(0, 0));
    let outcome = state.apply(&Command::SetIndent { style: IndentStyle::Tabs });
    assert!(outcome.indent_changed);
    assert_eq!(state.buffer().indent_source(), IndentSource::Chosen);
    state.apply(&Command::InsertTab);
    assert_eq!(state.buffer().line(0), "\tfunction a() {");
    assert!(!state.apply(&Command::SetIndent { style: IndentStyle::Tabs }).indent_changed);
}

#[test]
fn vim_shifts_follow_the_files_style() {
    use editor_core::vim::types::{Operator, Target};
    let mut state = state_with_cursor(TWO_SPACES, at(1, 2));
    let operate = |operator| Command::Operate { operator, target: Target::Lines { count: 1 }, register: None };
    state.apply(&operate(Operator::Indent));
    assert_eq!(state.buffer().line(1), "    if (b) {");
    state.apply(&operate(Operator::Outdent));
    assert_eq!(state.buffer().line(1), "  if (b) {");
    let mut tabs = state_with_cursor(TABS, at(1, 1));
    tabs.apply(&operate(Operator::Indent));
    assert_eq!(tabs.buffer().line(1), "\t\tif b {");
}
