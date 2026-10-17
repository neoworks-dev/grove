//! Visual block mode (`Ctrl-V`): a rectangle of text, kept as one selection on each line it
//! crosses so that every operator, and typing after `I`, `A` or `c`, works at all of them at once
//! as it does with several cursors. The two corners are remembered here, since the selections
//! alone cannot say which corner moves.

use crate::buffer::Position;
use crate::command::Outcome;
use crate::movement::Motion;
use crate::selections::{Selection, Selections};
use crate::state::EditorState;
use crate::vim::motion::reach;
use crate::vim::plan::clamp_to_line;
use crate::vim::types::BlockExit;

/// The corners of the block: where it started, and the one that moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub anchor: Position,
    pub head: Position,
    /// Whether the block runs to the end of every line, as after `$`.
    pub to_line_end: bool,
    /// The column up and down aim for.
    pub goal_column: Option<usize>,
}

impl Block {
    /// The first row and the last row of the block.
    fn rows(&self) -> (usize, usize) {
        (self.anchor.row.min(self.head.row), self.anchor.row.max(self.head.row))
    }

    /// The first column and the last column of the block.
    fn columns(&self) -> (usize, usize) {
        (self.anchor.column.min(self.head.column), self.anchor.column.max(self.head.column))
    }
}

impl EditorState {
    /// Starts a block at the newest selection's ends, or at the cursor.
    pub(crate) fn block_start(&mut self) -> Outcome {
        let newest = self.selections.newest();
        let anchor = clamp_to_line(&self.buffer, newest.anchor);
        let head = clamp_to_line(&self.buffer, newest.head);
        self.block = Some(Block { anchor, head, to_line_end: false, goal_column: None });
        self.block_apply();
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }

    /// Moves the block's moving corner, as a motion moves a cursor.
    pub(crate) fn block_move(&mut self, motion: Motion, count: usize) -> Outcome {
        let Some(mut block) = self.block else {
            return Outcome::default();
        };
        let from = Selection { anchor: block.head, head: block.head, goal_column: block.goal_column };
        let Some(reached) = reach(&self.buffer, &from, motion, count, false) else {
            return Outcome::default();
        };
        block.head = clamp_to_line(&self.buffer, reached.position);
        block.goal_column = reached.goal_column;
        match motion {
            Motion::LineEnd => block.to_line_end = true,
            Motion::Vertical(_) | Motion::Line(_) => {}
            _ => block.to_line_end = false,
        }
        self.block = Some(block);
        self.block_apply();
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }

    /// `o`: the moving corner becomes the other one.
    pub(crate) fn block_swap(&mut self) -> Outcome {
        let Some(block) = self.block else {
            return Outcome::default();
        };
        self.block = Some(Block { anchor: block.head, head: block.anchor, goal_column: None, ..block });
        self.block_apply();
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }

    /// Ends the block, leaving the selections as `exit` says.
    pub(crate) fn block_end(&mut self, exit: BlockExit) -> Outcome {
        let Some(block) = self.block.take() else {
            return Outcome::default();
        };
        match exit {
            BlockExit::Keep => {
                let all = self.selections.all().to_vec();
                self.selections = Selections::from_list(all, 0);
            }
            BlockExit::Head => self.selections = Selections::single(clamp_to_line(&self.buffer, block.head)),
            BlockExit::TopLeft => {
                let (top, _) = block.rows();
                let (left, _) = block.columns();
                let corner = clamp_to_line(&self.buffer, Position { row: top, column: left });
                self.selections = Selections::single(corner);
            }
            BlockExit::Range => {
                self.selections = Selections::from_list(vec![Selection::spanning(block.anchor, block.head)], 0);
            }
        }
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }

    /// `I` and `A`: a cursor at the start of the block's columns on every line, or after its
    /// last column, which is where typing then goes on all of them.
    pub(crate) fn block_insert(&mut self, append: bool) -> Outcome {
        let Some(block) = self.block.take() else {
            return Outcome::default();
        };
        let (top, bottom) = block.rows();
        let (left, right) = block.columns();
        let mut cursors = Vec::new();
        for row in top..=bottom {
            let length = self.buffer.line_length(row);
            if !append && length < left {
                continue;
            }
            let column = if !append {
                left
            } else if block.to_line_end {
                length
            } else {
                (right + 1).min(length)
            };
            cursors.push(Selection::cursor(Position { row, column }));
        }
        if cursors.is_empty() {
            cursors.push(Selection::cursor(block.head));
        }
        self.selections = Selections::from_list(cursors, 0);
        Outcome { changed: true, reveal_newest: true, ..Outcome::default() }
    }

    /// Sets the selections to the block: one on each line it crosses that has a character in
    /// its columns, and the one on the moving corner's line is the newest.
    pub(crate) fn block_apply(&mut self) {
        let Some(block) = self.block else {
            return;
        };
        let (top, bottom) = block.rows();
        let (left, right) = block.columns();
        let mut list = Vec::new();
        let mut newest = None;
        for row in top..=bottom {
            let length = self.buffer.line_length(row);
            if length == 0 || left >= length {
                continue;
            }
            let last = if block.to_line_end { length - 1 } else { right.min(length - 1) };
            if row == block.head.row {
                newest = Some(list.len());
            }
            // The head sits on the side of the moving corner, so the cursor is drawn there.
            let (anchor_column, head_column) = if block.head.column < block.anchor.column { (last, left) } else { (left, last) };
            list.push(Selection::spanning(
                Position { row, column: anchor_column },
                Position { row, column: head_column },
            ));
        }
        if list.is_empty() {
            list.push(Selection::cursor(block.head));
        }
        let newest = newest.unwrap_or(list.len() - 1);
        self.selections = Selections::from_list(list, newest);
    }
}

#[cfg(test)]
mod tests {
    use crate::buffer::{Buffer, Position};
    use crate::command::Command;
    use crate::movement::Motion;
    use crate::state::EditorState;
    use crate::vim::types::BlockExit;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn a_block_selects_the_same_columns_on_each_line_and_skips_short_ones() {
        let mut state = EditorState::new(Buffer::from_text("abcd\nab\nabcd\n"));
        state.apply(&Command::PlaceCursor { at: at(0, 1) });
        state.apply(&Command::BlockStart);
        state.apply(&Command::BlockMove { motion: Motion::Vertical(2), count: 1 });
        state.apply(&Command::BlockMove { motion: Motion::ColumnRight, count: 1 });
        let ranges: Vec<_> = state.selections().all().iter().map(|s| (s.anchor, s.head)).collect();
        assert_eq!(ranges, vec![(at(0, 1), at(0, 2)), (at(1, 1), at(1, 1)), (at(2, 1), at(2, 2))]);
        state.apply(&Command::BlockEnd { exit: BlockExit::Head });
        assert_eq!(state.selections().count(), 1);
        assert_eq!(state.selections().newest().head, at(2, 2));
    }

    #[test]
    fn dollar_takes_every_line_to_its_end() {
        let mut state = EditorState::new(Buffer::from_text("abc\nabcdef\n"));
        state.apply(&Command::BlockStart);
        state.apply(&Command::BlockMove { motion: Motion::Vertical(1), count: 1 });
        state.apply(&Command::BlockMove { motion: Motion::LineEnd, count: 1 });
        let ranges: Vec<_> = state.selections().all().iter().map(|s| (s.anchor, s.head)).collect();
        assert_eq!(ranges, vec![(at(0, 0), at(0, 2)), (at(1, 0), at(1, 5))]);
    }
}
