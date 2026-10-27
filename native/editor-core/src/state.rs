//! What an editor is, apart from how it is shown: the buffer and the selections in it.

use std::time::Instant;

use crate::anchor::{Anchor, AnchorId, Anchors, Bias};
use crate::buffer::{Buffer, LineEnding, Position};
use crate::command::{Command, Outcome};
use crate::completion::{Completion, SnippetSession};
use crate::decorations::{Decoration, Decorations, Placed, PlacedBlock, SourceFilter};
use crate::history::History;
use crate::movement::{Motion, find_next, move_selection, vertical, word_at};
use crate::selections::{Selection, Selections};
use crate::syntax::{HighlightSpan, Scope, Syntax};
use crate::vim::registers::VimMemory;
use std::collections::HashMap;

pub struct EditorState {
    pub(crate) buffer: Buffer,
    pub(crate) selections: Selections,
    /// The places other things have pinned to the text, kept up to date through every edit.
    pub(crate) anchors: Anchors,
    pub(crate) history: History,
    /// Identifies the text as it is now. Every change makes a new one, and undo goes back to
    /// the one before, so the text is unmodified exactly when this is the saved one.
    pub(crate) revision: u64,
    pub(crate) next_revision: u64,
    saved_revision: u64,
    /// The start and end of the text an input method is composing, if any.
    pub(crate) marked: Option<(AnchorId, AnchorId)>,
    /// The text of the last copy that took whole lines, so pasting it puts the lines above the cursor.
    pub(crate) whole_line_copy: Option<String>,
    /// The parse of the text, kept up to date after every command.
    syntax: Syntax,
    /// What sources have put on top of the text, pinned to anchors.
    decorations: Decorations,
    /// The snippet whose tab stops are being visited, if one was just completed.
    pub(crate) snippet: Option<SnippetSession>,
    /// What vim's registers and search remember. A document set puts one shared set here for
    /// the length of each command, so a yank in one file can be put in another.
    pub memory: VimMemory,
    /// The places vim's marks name, pinned so they follow the text.
    pub(crate) marks: HashMap<char, AnchorId>,
    /// The last visual selection, for `gv` and for `.` after an operator on a selection.
    pub(crate) last_visual: Option<crate::vim::recall::LastVisual>,
    /// The corners of the visual block being selected.
    pub(crate) block: Option<crate::vim::block::Block>,
    /// The places jumped from, for `Ctrl-O` and `Ctrl-I`.
    pub(crate) jumps: crate::vim::recall::JumpList,
    /// What the characters typed in replace mode covered, for Backspace to put back.
    pub(crate) overwritten: Vec<crate::vim::recall::Overwritten>,
}

impl EditorState {
    /// A state over a buffer, with one cursor at its start.
    pub fn new(mut buffer: Buffer) -> Self {
        let syntax = Syntax::new(&mut buffer);
        EditorState {
            buffer,
            selections: Selections::single(Position::default()),
            anchors: Anchors::default(),
            history: History::default(),
            revision: 0,
            next_revision: 0,
            saved_revision: 0,
            marked: None,
            whole_line_copy: None,
            syntax,
            decorations: Decorations::default(),
            snippet: None,
            memory: VimMemory::default(),
            marks: HashMap::new(),
            last_visual: None,
            block: None,
            jumps: Default::default(),
            overwritten: Vec::new(),
        }
    }

    /// Hands over the changes made to the text since the last call, in a language server's
    /// terms, so the server can be kept in step with the text.
    pub fn take_content_changes(&mut self) -> Vec<crate::buffer::ContentChange> {
        self.buffer.take_content_changes()
    }

    /// Replaces every decoration a source has with `decorations`, pinning them to the text as it
    /// is now. An empty list removes the source; other sources are untouched.
    pub fn set_decorations(&mut self, source: &str, decorations: &[Decoration]) {
        self.decorations.replace(source, decorations, &self.buffer, &mut self.anchors);
    }

    /// How many decorations a source has.
    pub fn decoration_count(&self, source: &str) -> usize {
        self.decorations.count(source)
    }

    /// The decorations that touch any of `rows`, positioned as the text is now.
    pub fn decorations_in_rows(&self, rows: std::ops::Range<usize>) -> Vec<Placed<'_>> {
        self.decorations_in_rows_for(rows, &SourceFilter::default())
    }

    /// Like `decorations_in_rows`, with only the sources a view shows.
    pub fn decorations_in_rows_for(&self, rows: std::ops::Range<usize>, filter: &SourceFilter) -> Vec<Placed<'_>> {
        self.decorations.placed_in_rows(rows, &self.buffer, &self.anchors, filter)
    }

    /// The blocks between lines, in the order they are laid out.
    pub fn decoration_blocks(&self) -> Vec<PlacedBlock<'_>> {
        self.decoration_blocks_for(&SourceFilter::default())
    }

    /// Like `decoration_blocks`, with only the sources a view shows.
    pub fn decoration_blocks_for(&self, filter: &SourceFilter) -> Vec<PlacedBlock<'_>> {
        self.decorations.blocks(&self.buffer, &self.anchors, filter)
    }

    /// How many anchors are being kept up to date, which tests use to see none are leaked.
    pub fn anchor_count(&self) -> usize {
        self.anchors.len()
    }

    /// The highlight runs of each row in `rows`, as character columns of the row.
    pub fn highlights(&self, rows: std::ops::Range<usize>) -> Vec<Vec<HighlightSpan>> {
        self.syntax.highlights(&self.buffer, rows)
    }

    /// The named scopes (functions, classes, modules) that enclose a position, outermost first.
    pub fn scopes_at(&self, position: Position) -> Vec<Scope> {
        let offset = self.buffer.offset_of(position);
        let byte = self.buffer.rope().char_to_byte(offset);
        self.syntax.scopes_at(&self.buffer, byte)
    }

    /// Picks the text's language again when grammars extensions brought since it was opened claim
    /// its file. Says whether the highlighting changed.
    pub fn refresh_syntax(&mut self) -> bool {
        if !self.syntax.language_may_have_changed(&self.buffer) {
            return false;
        }
        self.syntax = Syntax::new(&mut self.buffer);
        true
    }

    /// The name of the language the text is highlighted as, if it is recognised.
    pub fn language_name(&self) -> Option<&'static str> {
        self.syntax.language_name()
    }

    /// Whether the text differs from what was last read from or written to its file.
    pub fn is_modified(&self) -> bool {
        self.revision != self.saved_revision
    }

    /// The text being composed by an input method, as the positions it starts and ends at.
    pub fn marked_range(&self) -> Option<(Position, Position)> {
        let (start, end) = self.marked?;
        let start = self.anchors.get(start)?;
        let end = self.anchors.get(end)?;
        Some((self.buffer.position_of(start.offset), self.buffer.position_of(end.offset)))
    }

    /// Pins a place in the text that keeps its meaning through edits, such as one a squiggle
    /// or a blame annotation is drawn at. `bias` says which side of text inserted exactly there
    /// it stays on.
    pub fn create_anchor(&mut self, at: Position, bias: Bias) -> AnchorId {
        self.anchors.insert(Anchor { offset: self.buffer.offset_of(at), bias })
    }

    /// Where an anchor is now, or none once it has been removed.
    pub fn anchor_position(&self, id: AnchorId) -> Option<Position> {
        let anchor = self.anchors.get(id)?;
        Some(self.buffer.position_of(anchor.offset))
    }

    /// Stops keeping an anchor up to date.
    pub fn remove_anchor(&mut self, id: AnchorId) {
        self.anchors.remove(id);
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

    /// Takes the text a file has on disk after another program changed it, as one step for undo
    /// that keeps the selections outside the changed stretch in place, and counts it as saved.
    /// Says whether the text changed.
    pub fn take_disk_text(&mut self, text: &str) -> bool {
        let mut normalized = text.to_string();
        if self.buffer.line_ending() == LineEnding::Crlf {
            normalized = text.replace("\r\n", "\n");
        }
        self.history.close_group();
        let changed = self.replace_differing_text(&normalized, Instant::now());
        self.history.close_group();
        self.syntax.update(&mut self.buffer);
        self.saved_revision = self.revision;
        changed
    }

    /// Applies a command. This is the only way the buffer and the selections change.
    pub fn apply(&mut self, command: &Command) -> Outcome {
        self.apply_at(command, Instant::now())
    }

    /// Applies a command that happened at a given time, which decides whether typed text joins
    /// the typing before it.
    pub fn apply_at(&mut self, command: &Command, now: Instant) -> Outcome {
        let before = self.selections.clone();
        let continues_typing = matches!(
            command,
            Command::InsertText { .. } | Command::SetMarkedText { .. } | Command::SetDecorations { .. }
        );
        if !continues_typing {
            self.history.close_group();
        }
        if crate::completion::leaves_snippet(command) {
            self.end_snippet();
        }
        let mut outcome = self.run(command, now);
        self.syntax.update(&mut self.buffer);
        outcome.changed = outcome.changed || self.selections != before;
        outcome
    }

    /// Runs a command and says what it did, apart from whether the selections changed.
    fn run(&mut self, command: &Command, now: Instant) -> Outcome {
        match command {
            Command::InsertText { text } => self.insert_text(text, now),
            Command::Delete { motion } => self.delete(*motion, now),
            Command::InsertNewline => self.insert_newline(now),
            Command::InsertTab => self.insert_tab(now),
            Command::Indent => self.shift_lines(false, now),
            Command::Outdent => self.shift_lines(true, now),
            Command::SetIndent { style } => self.set_indent(*style),
            Command::StartJump { then } => Outcome { jump: Some((**then).clone()), ..Outcome::default() },
            Command::Undo => self.undo_outcome(),
            Command::Redo => self.redo_outcome(),
            Command::Copy => self.copy(),
            Command::Cut => self.cut(now),
            Command::Paste { text } => self.paste(text, now),
            Command::PasteClipboard => Outcome::default(),
            Command::Save => self.save(),
            Command::SetMarkedText { text } => self.set_marked_text(text, now),
            Command::UnmarkText => {
                self.clear_marked();
                Outcome::default()
            }
            Command::ReplaceRange { start, end, text } => self.replace_range(*start, *end, text, now),
            Command::ApplyEdits { edits } => self.apply_range_edits(edits, now),
            Command::SetDecorations { source, decorations } => {
                self.set_decorations(source, decorations);
                Outcome { decorations_changed: true, ..Outcome::default() }
            }
            Command::InsertCompletion { before, after, text, snippet, additional } => {
                let completion = Completion { before: *before, after: *after, text, snippet: *snippet, additional };
                self.insert_completion(&completion, now)
            }
            Command::SnippetNext => self.snippet_next(),
            Command::SnippetPrevious => self.snippet_previous(),
            _ if command.is_vim() => self.run_vim(command, now),
            _ => self.run_navigation(command),
        }
    }

    /// Runs a command that moves or selects, and never touches the text.
    fn run_navigation(&mut self, command: &Command) -> Outcome {
        let reveal_newest = self.navigate(command);
        Outcome { reveal_newest, ..Outcome::default() }
    }

    /// Takes back the last transaction, and says that the text and the selections changed.
    fn undo_outcome(&mut self) -> Outcome {
        let changed = self.undo();
        Outcome { changed, text_changed: changed, reveal_newest: changed, ..Outcome::default() }
    }

    /// Does the last undone transaction again.
    fn redo_outcome(&mut self) -> Outcome {
        let changed = self.redo();
        Outcome { changed, text_changed: changed, reveal_newest: changed, ..Outcome::default() }
    }

    /// Writes the buffer to its file, and the text counts as unmodified if that worked.
    fn save(&mut self) -> Outcome {
        match self.buffer.save() {
            Ok(()) => {
                self.saved_revision = self.revision;
                Outcome { saved: true, ..Outcome::default() }
            }
            Err(error) => Outcome { error: Some(error.to_string()), ..Outcome::default() },
        }
    }

    /// Runs a navigation command and says whether the view should follow the newest selection.
    fn navigate(&mut self, command: &Command) -> bool {
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
            _ => false,
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
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: true, ..Outcome::default() });
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
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: false, ..Outcome::default() });
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
        assert_eq!(outcome, Outcome { changed: true, reveal_newest: false, ..Outcome::default() });
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
