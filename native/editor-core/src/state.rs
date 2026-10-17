//! What an editor is, apart from how it is shown: the buffer and the selections in it.

use crate::buffer::{Buffer, Position};
use crate::command::{Command, Outcome};
use crate::movement::{Motion, find_next, move_selection, vertical, word_at};
use crate::selections::{Selection, Selections};

pub struct EditorState {
    buffer: Buffer,
    selections: Selections,
}

impl EditorState {
    /// A state over a buffer, with one cursor at its start.
    pub fn new(buffer: Buffer) -> Self {
        EditorState { buffer, selections: Selections::single(Position::default()) }
    }

    /// The text.
    pub fn buffer(&self) -> &Buffer {
        &self.buffer
    }

    /// The selections in it.
    pub fn selections(&self) -> &Selections {
        &self.selections
    }

    /// Swaps in another buffer, such as a newly opened file, with one cursor at its start.
    pub fn replace_buffer(&mut self, buffer: Buffer) {
        *self = EditorState::new(buffer);
    }

    /// Applies a command. This is the only way the buffer and the selections change.
    pub fn apply(&mut self, command: &Command) -> Outcome {
        let before = self.selections.clone();
        let reveal_newest = self.run(command);
        Outcome { changed: self.selections != before, reveal_newest }
    }

    /// Runs a command and says whether the view should follow the newest selection.
    fn run(&mut self, command: &Command) -> bool {
        match command {
            Command::MoveSelections { motion, extend } => {
                self.move_selections(*motion, *extend);
                true
            }
            Command::AddCursorAbove => self.add_cursor_vertically(-1),
            Command::AddCursorBelow => self.add_cursor_vertically(1),
            Command::SelectNextOccurrence => self.select_next_occurrence(),
            Command::SelectAll => {
                self.select_all();
                false
            }
            Command::CollapseSelections => {
                self.collapse_selections();
                false
            }
            Command::PlaceCursor { at } => {
                self.selections = Selections::single(self.buffer.clamp(*at));
                false
            }
            Command::ToggleCursor { at } => {
                self.toggle_cursor(self.buffer.clamp(*at));
                false
            }
            Command::ExtendNewestTo { at } => {
                self.extend_newest_to(self.buffer.clamp(*at));
                false
            }
            Command::SelectWordAt { at } => {
                self.select_word_at(self.buffer.clamp(*at));
                false
            }
        }
    }

    /// Moves every selection.
    fn move_selections(&mut self, motion: Motion, extend: bool) {
        let buffer = &self.buffer;
        self.selections.transform(|selection| move_selection(buffer, selection, motion, extend));
    }

    /// Adds a cursor one line above the topmost selection, or below the bottommost. Returns
    /// whether one was added; there is none to add at the first or last line.
    fn add_cursor_vertically(&mut self, direction: isize) -> bool {
        let all = self.selections.all();
        let edge = if direction < 0 { all[0] } else { all[all.len() - 1] };
        let (head, goal_column) = vertical(&self.buffer, &edge, direction);
        if head.row == edge.head.row {
            return false;
        }
        self.selections.add(Selection { anchor: head, head, goal_column });
        true
    }

    /// Selects the word at the newest cursor, or adds a selection at the next place the newest
    /// selection's text occurs. Returns whether a selection was added.
    fn select_next_occurrence(&mut self) -> bool {
        let newest = self.selections.newest();
        if newest.is_empty() {
            if let Some(word) = word_at(&self.buffer, newest.head) {
                self.selections.replace_newest(word);
            }
            return false;
        }
        let needle = self.buffer.text_between(newest.start(), newest.end());
        let Some(found) = find_next(&self.buffer, &needle, newest.end()) else {
            return false;
        };
        self.selections.add(found);
        true
    }

    /// Selects the whole buffer.
    fn select_all(&mut self) {
        let end = self.buffer.clamp(Position { row: usize::MAX, column: usize::MAX });
        self.selections = Selections::single(Position::default());
        self.selections.replace_newest(Selection::spanning(Position::default(), end));
    }

    /// Back to one cursor, then to no selection.
    fn collapse_selections(&mut self) {
        if self.selections.keep_only_newest() {
            return;
        }
        let newest = self.selections.newest();
        if !newest.is_empty() {
            self.selections.replace_newest(Selection::cursor(newest.head));
        }
    }

    /// Removes the cursor at a position, or adds one if there is none.
    fn toggle_cursor(&mut self, at: Position) {
        if !self.selections.remove_cursor_at(at) {
            self.selections.add(Selection::cursor(at));
        }
    }

    /// Moves the newest selection's head while keeping its anchor.
    fn extend_newest_to(&mut self, at: Position) {
        let anchor = self.selections.newest().anchor;
        self.selections.replace_newest(Selection::spanning(anchor, at));
    }

    /// Replaces the newest selection with the word at a position, if there is one.
    fn select_word_at(&mut self, at: Position) {
        if let Some(word) = word_at(&self.buffer, at) {
            self.selections.replace_newest(word);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn state(text: &str) -> EditorState {
        EditorState::new(Buffer::from_text(text))
    }

    fn heads(state: &EditorState) -> Vec<Position> {
        state.selections().all().iter().map(|selection| selection.head).collect()
    }

    fn move_by(motion: Motion, extend: bool) -> Command {
        Command::MoveSelections { motion, extend }
    }

    #[test]
    fn moving_reports_a_change_and_asks_to_follow() {
        let mut state = state("abc\ndef");
        let outcome = state.apply(&move_by(Motion::Right, false));
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: true });
        assert_eq!(heads(&state), vec![at(0, 1)]);
    }

    #[test]
    fn moving_against_the_edge_changes_nothing() {
        let mut state = state("abc");
        let outcome = state.apply(&move_by(Motion::Left, false));
        assert!(!outcome.changed);
    }

    #[test]
    fn moves_reach_every_selection_and_extending_keeps_anchors() {
        let mut state = state("abc\ndef");
        state.apply(&Command::AddCursorBelow);
        state.apply(&move_by(Motion::LineEnd, true));
        assert_eq!(
            state.selections().all(),
            &[Selection::spanning(at(0, 0), at(0, 3)), Selection::spanning(at(1, 0), at(1, 3))]
        );
    }

    #[test]
    fn buffer_ends_are_motions() {
        let mut state = state("abc\ndef");
        state.apply(&move_by(Motion::BufferEnd, false));
        assert_eq!(heads(&state), vec![at(1, 3)]);
        state.apply(&move_by(Motion::BufferStart, false));
        assert_eq!(heads(&state), vec![at(0, 0)]);
    }

    #[test]
    fn cursors_are_added_above_and_below_with_the_goal_column() {
        let mut state = state("abcdef\nab\nabcdef");
        state.apply(&move_by(Motion::LineEnd, false));
        let outcome = state.apply(&Command::AddCursorBelow);
        assert!(outcome.reveal_newest);
        state.apply(&Command::AddCursorBelow);
        assert_eq!(heads(&state), vec![at(0, 6), at(1, 2), at(2, 6)]);
        state.apply(&Command::AddCursorAbove);
        assert_eq!(state.selections().count(), 3);
    }

    #[test]
    fn no_cursor_is_added_past_the_first_or_last_line() {
        let mut state = state("one\ntwo");
        assert_eq!(state.apply(&Command::AddCursorAbove), Outcome::default());
        state.apply(&Command::AddCursorBelow);
        assert_eq!(state.apply(&Command::AddCursorBelow), Outcome::default());
        assert_eq!(state.selections().count(), 2);
    }

    #[test]
    fn select_next_occurrence_takes_the_word_then_each_match() {
        let mut state = state("foo bar\nfoo\nfoo");
        let outcome = state.apply(&Command::SelectNextOccurrence);
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: false });
        assert_eq!(state.selections().all(), &[Selection::spanning(at(0, 0), at(0, 3))]);
        let outcome = state.apply(&Command::SelectNextOccurrence);
        assert!(outcome.reveal_newest);
        state.apply(&Command::SelectNextOccurrence);
        assert_eq!(state.selections().count(), 3);
        state.apply(&Command::SelectNextOccurrence);
        assert_eq!(state.selections().count(), 3);
    }

    #[test]
    fn select_next_occurrence_between_words_does_nothing() {
        let mut state = state("a  b");
        state.apply(&move_by(Motion::Right, false));
        state.apply(&move_by(Motion::Right, false));
        assert!(!state.apply(&Command::SelectNextOccurrence).changed);
    }

    #[test]
    fn select_all_covers_the_buffer() {
        let mut state = state("abc\ndef");
        state.apply(&Command::AddCursorBelow);
        state.apply(&Command::SelectAll);
        assert_eq!(state.selections().all(), &[Selection::spanning(at(0, 0), at(1, 3))]);
    }

    #[test]
    fn collapse_goes_to_one_cursor_then_to_no_selection_then_changes_nothing() {
        let mut state = state("abc\ndef");
        state.apply(&Command::AddCursorBelow);
        state.apply(&move_by(Motion::LineEnd, true));
        assert!(state.apply(&Command::CollapseSelections).changed);
        assert_eq!(state.selections().count(), 1);
        assert!(!state.selections().newest().is_empty());
        assert!(state.apply(&Command::CollapseSelections).changed);
        assert!(state.selections().newest().is_empty());
        assert!(!state.apply(&Command::CollapseSelections).changed);
    }

    #[test]
    fn only_collapse_passes_on_when_nothing_changed() {
        assert!(Command::CollapseSelections.passes_on_when_unchanged());
        assert!(!Command::SelectAll.passes_on_when_unchanged());
    }

    #[test]
    fn placing_a_cursor_replaces_every_selection_and_clamps() {
        let mut state = state("abc\ndef");
        state.apply(&Command::AddCursorBelow);
        let outcome = state.apply(&Command::PlaceCursor { at: at(0, 99) });
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: false });
        assert_eq!(heads(&state), vec![at(0, 3)]);
    }

    #[test]
    fn toggling_adds_a_cursor_and_removes_it_again() {
        let mut state = state("abc\ndef");
        state.apply(&Command::ToggleCursor { at: at(1, 1) });
        assert_eq!(heads(&state), vec![at(0, 0), at(1, 1)]);
        state.apply(&Command::ToggleCursor { at: at(1, 1) });
        assert_eq!(heads(&state), vec![at(0, 0)]);
        assert!(!state.apply(&Command::ToggleCursor { at: at(0, 0) }).changed);
    }

    #[test]
    fn extending_moves_the_head_and_keeps_the_anchor() {
        let mut state = state("abc\ndef");
        state.apply(&Command::PlaceCursor { at: at(0, 1) });
        state.apply(&Command::ExtendNewestTo { at: at(1, 2) });
        assert_eq!(state.selections().all(), &[Selection::spanning(at(0, 1), at(1, 2))]);
    }

    #[test]
    fn selecting_a_word_replaces_the_newest_selection() {
        let mut state = state("let name = 1;");
        state.apply(&Command::SelectWordAt { at: at(0, 6) });
        assert_eq!(state.selections().all(), &[Selection::spanning(at(0, 4), at(0, 8))]);
        assert!(!state.apply(&Command::SelectWordAt { at: at(0, 9) }).changed);
    }

    #[test]
    fn replacing_the_buffer_starts_over_with_one_cursor() {
        let mut state = state("abc");
        state.apply(&Command::SelectAll);
        state.replace_buffer(Buffer::from_text("xyz"));
        assert_eq!(state.selections().all(), &[Selection::cursor(at(0, 0))]);
    }

    #[test]
    fn commands_round_trip_through_json() {
        let commands = [
            Command::MoveSelections { motion: Motion::Vertical(-5), extend: true },
            Command::MoveSelections { motion: Motion::LineEnd, extend: false },
            Command::AddCursorAbove,
            Command::SelectNextOccurrence,
            Command::PlaceCursor { at: at(3, 4) },
            Command::SelectWordAt { at: at(1, 2) },
        ];
        for command in commands {
            let json = serde_json::to_value(&command).unwrap();
            assert_eq!(serde_json::from_value::<Command>(json).unwrap(), command);
        }
    }

    #[test]
    fn commands_from_svelte_read_naturally() {
        let command: Command = serde_json::from_str(r#"{"type": "move_selections", "motion": "left"}"#).unwrap();
        assert_eq!(command, Command::MoveSelections { motion: Motion::Left, extend: false });
        let command: Command =
            serde_json::from_str(r#"{"type": "toggle_cursor", "at": {"row": 2, "column": 1}}"#).unwrap();
        assert_eq!(command, Command::ToggleCursor { at: at(2, 1) });
        assert!(serde_json::from_str::<Command>(r#"{"type": "fly"}"#).is_err());
    }
}
