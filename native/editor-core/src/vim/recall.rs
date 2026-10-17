//! What vim remembers about one document as it is used: the last visual selection (`gv`, and `.`
//! after an operator on a selection), the jump list (`Ctrl-O` and `Ctrl-I`), and the characters
//! replace mode typed over, which Backspace puts back.

use std::time::Instant;

use crate::anchor::{AnchorId, Bias};
use crate::buffer::Position;
use crate::command::Outcome;
use crate::edit::Edit;
use crate::editing::edited;
use crate::selections::Selection;
use crate::state::EditorState;
use crate::vim::plan::{CursorSpec, Plan, clamp_to_line};
use crate::vim::types::SelectionKind;

/// The most places the jump list keeps, the oldest going first.
const MAX_JUMPS: usize = 100;

/// A visual selection that was left: where it started and ended, and which kind it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LastVisual {
    pub start: Position,
    pub end: Position,
    pub kind: SelectionKind,
}

/// The places jumped from, oldest first, with the one `Ctrl-O` and `Ctrl-I` are at.
#[derive(Debug, Default)]
pub struct JumpList {
    entries: Vec<AnchorId>,
    /// The entry the cursor is at when jumping about; the length of the list when it is not in it.
    index: usize,
}

/// What one typed character of replace mode covered, for each cursor in order: how many
/// characters were typed and the text that was there before.
pub type Overwritten = Vec<(usize, String)>;

impl EditorState {
    /// Remembers the selection that is about to be left, for `gv` and for `.`.
    pub(crate) fn remember_visual(&mut self, kind: SelectionKind) {
        if let Some(block) = self.block {
            self.last_visual = Some(LastVisual { start: block.anchor, end: block.head, kind });
            return;
        }
        let all = self.selections.all();
        let first = all[0];
        let last = all[all.len() - 1];
        self.last_visual = Some(LastVisual { start: first.start(), end: last.end(), kind });
    }

    /// Selects the last visual selection again, kept on characters of the text it now has.
    pub(crate) fn reselect_visual(&mut self) -> Outcome {
        let Some(last) = self.last_visual else {
            return Outcome::default();
        };
        let start = clamp_to_line(&self.buffer, last.start);
        let end = clamp_to_line(&self.buffer, last.end);
        if last.kind == SelectionKind::Block {
            self.block =
                Some(crate::vim::block::Block { anchor: start, head: end, to_line_end: false, goal_column: None });
            self.block_apply();
            return Outcome { reveal_newest: true, changed: true, ..Outcome::default() };
        }
        self.selections.replace_newest(Selection::spanning(start, end));
        Outcome { reveal_newest: true, changed: true, ..Outcome::default() }
    }

    /// Selects, from the cursor, as much text as the last visual selection covered, for `.` to
    /// do an operator on it again.
    pub(crate) fn select_last_extent(&mut self) -> Outcome {
        let Some(last) = self.last_visual else {
            return Outcome::default();
        };
        let cursor = self.selections.newest().head;
        if last.kind == SelectionKind::Block {
            let rows = last.start.row.abs_diff(last.end.row);
            let columns = last.start.column.abs_diff(last.end.column);
            let head = clamp_to_line(&self.buffer, Position { row: cursor.row + rows, column: cursor.column + columns });
            self.block = Some(crate::vim::block::Block { anchor: cursor, head, to_line_end: false, goal_column: None });
            self.block_apply();
            return Outcome { changed: true, ..Outcome::default() };
        }
        let rows = last.end.row - last.start.row;
        let end = if rows == 0 {
            Position { row: cursor.row, column: cursor.column + last.end.column.saturating_sub(last.start.column) }
        } else {
            Position { row: cursor.row + rows, column: last.end.column }
        };
        let end = clamp_to_line(&self.buffer, end);
        self.selections.replace_newest(Selection::spanning(cursor, end));
        Outcome { changed: true, ..Outcome::default() }
    }

    /// Notes the cursor's place as one to come back to with `Ctrl-O`.
    pub(crate) fn push_jump(&mut self) {
        let at = self.selections.newest().head;
        self.record_jump(at);
    }

    /// Adds a place to the jump list, taking an older place on the same line out of it, and
    /// leaves the list at its end.
    fn record_jump(&mut self, at: Position) {
        let older = std::mem::take(&mut self.jumps.entries);
        let mut kept = Vec::new();
        for anchor in older {
            match self.anchor_position(anchor) {
                Some(position) if position.row != at.row => kept.push(anchor),
                _ => self.anchors.remove(anchor),
            }
        }
        let anchor = self.create_anchor(at, Bias::Left);
        kept.push(anchor);
        while kept.len() > MAX_JUMPS {
            let oldest = kept.remove(0);
            self.anchors.remove(oldest);
        }
        self.jumps.index = kept.len();
        self.jumps.entries = kept;
    }

    /// `Ctrl-O`: goes `count` places back in the jump list. The place the jump started from is
    /// added first, so `Ctrl-I` can return to it.
    pub(crate) fn jump_older(&mut self, count: usize) -> Outcome {
        if self.jumps.index >= self.jumps.entries.len() {
            let here = self.selections.newest().head;
            self.record_jump(here);
            self.jumps.index = self.jumps.entries.len() - 1;
        }
        if self.jumps.index == 0 {
            return Outcome::default();
        }
        self.jumps.index = self.jumps.index.saturating_sub(count.max(1));
        self.go_to_jump()
    }

    /// `Ctrl-I`: goes `count` places forward in the jump list, if there are that many.
    pub(crate) fn jump_newer(&mut self, count: usize) -> Outcome {
        let target = self.jumps.index + count.max(1);
        if target >= self.jumps.entries.len() {
            return Outcome::default();
        }
        self.jumps.index = target;
        self.go_to_jump()
    }

    /// Puts the cursor at the place the jump list is at.
    fn go_to_jump(&mut self) -> Outcome {
        let Some(anchor) = self.jumps.entries.get(self.jumps.index).copied() else {
            return Outcome::default();
        };
        let Some(position) = self.anchor_position(anchor) else {
            return Outcome::default();
        };
        let position = clamp_to_line(&self.buffer, position);
        self.selections.replace_newest(Selection::cursor(position));
        Outcome { reveal_newest: true, changed: true, ..Outcome::default() }
    }

    /// Backspace in replace mode: puts back the characters the last typed one covered, at every
    /// cursor. With nothing left to put back it only moves the cursors left.
    pub(crate) fn restore_overwritten(&mut self, now: Instant) -> Outcome {
        let cursors = self.selections.count();
        let Some(restored) = self.overwritten.pop().filter(|restored| restored.len() == cursors) else {
            self.selections.transform(|selection| {
                let column = selection.head.column.saturating_sub(1);
                Selection::cursor(Position { row: selection.head.row, column })
            });
            return Outcome { changed: true, ..Outcome::default() };
        };
        let plans: Vec<Plan> = self
            .selections
            .all()
            .iter()
            .zip(restored)
            .map(|(selection, (typed, original))| {
                let end = self.buffer.offset_of(selection.head);
                let start = end.saturating_sub(typed);
                Plan::single(Edit::replace(start..end, original), CursorSpec::InReplacement { edit: 0, offset: 0 })
            })
            .collect();
        edited(self.commit_plans(plans, false, now))
    }

    /// Notes what a character typed in replace mode covered, so Backspace can put it back.
    pub(crate) fn note_overwritten(&mut self, covered: Overwritten) {
        self.overwritten.push(covered);
    }
}

#[cfg(test)]
mod tests {
    use crate::buffer::{Buffer, Position};
    use crate::command::Command;
    use crate::state::EditorState;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn state(text: &str) -> EditorState {
        EditorState::new(Buffer::from_text(text))
    }

    #[test]
    fn the_jump_list_goes_back_and_forward() {
        let mut state = state("a\nb\nc\nd\n");
        state.apply(&Command::PlaceCursor { at: at(0, 0) });
        state.apply(&Command::PushJump);
        state.apply(&Command::PlaceCursor { at: at(2, 0) });
        state.apply(&Command::PushJump);
        state.apply(&Command::PlaceCursor { at: at(3, 0) });
        state.apply(&Command::JumpOlder { count: 1 });
        assert_eq!(state.selections().newest().head, at(2, 0));
        state.apply(&Command::JumpOlder { count: 1 });
        assert_eq!(state.selections().newest().head, at(0, 0));
        state.apply(&Command::JumpOlder { count: 1 });
        assert_eq!(state.selections().newest().head, at(0, 0));
        state.apply(&Command::JumpNewer { count: 1 });
        assert_eq!(state.selections().newest().head, at(2, 0));
        state.apply(&Command::JumpNewer { count: 1 });
        assert_eq!(state.selections().newest().head, at(3, 0));
        state.apply(&Command::JumpNewer { count: 1 });
        assert_eq!(state.selections().newest().head, at(3, 0));
    }

    #[test]
    fn jumps_follow_the_text_they_were_made_in() {
        let mut state = state("a\nb\nc\n");
        state.apply(&Command::PlaceCursor { at: at(2, 0) });
        state.apply(&Command::PushJump);
        state.apply(&Command::PlaceCursor { at: at(0, 0) });
        state.apply(&Command::InsertText { text: "new\n".to_string() });
        state.apply(&Command::JumpOlder { count: 1 });
        assert_eq!(state.selections().newest().head, at(3, 0));
    }
}
