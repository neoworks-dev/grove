//! Where each cursor key takes a selection's head, worked out from the buffer alone.

use crate::buffer::{Buffer, Position};
use crate::selections::Selection;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Motion {
    Left,
    Right,
    /// Rows up (negative) or down (positive); a page is many rows.
    Vertical(isize),
    LineStart,
    LineEnd,
    BufferStart,
    BufferEnd,
    // The motions below are vim's; the standard keymap does not make them.
    /// `h`: one column left, staying on the line.
    ColumnLeft,
    /// `l`: one column right, staying on the line.
    ColumnRight,
    /// `a`: one column right, which at the end of a line is past its last character.
    AfterCursor,
    /// `^`: the first character that is not white space.
    FirstNonBlank,
    /// `g_`: the last character that is not white space.
    LastNonBlank,
    /// `gg`, `G` and `:n`: the first non-blank of a row, counted from zero.
    Line(usize),
    /// `w` and `W`.
    WordForward {
        big: bool,
    },
    /// `e` and `E`.
    WordEnd {
        big: bool,
    },
    /// `b` and `B`.
    WordBack {
        big: bool,
    },
    /// `ge` and `gE`.
    WordEndBack {
        big: bool,
    },
    /// `}`.
    ParagraphForward,
    /// `{`.
    ParagraphBack,
    /// `%`.
    MatchingBracket,
    /// To a place, such as the one a jump label stands for.
    To(Position),
    /// `f`, `t`, `F` and `T`, and `;` and `,` which set `repeat`.
    FindChar {
        character: char,
        forward: bool,
        till: bool,
        repeat: bool,
    },
}

/// Moves a selection's head. Extending keeps the anchor; otherwise the selection becomes a
/// cursor, and left or right on a non-empty selection stops at its start or end, as in VS Code.
pub fn move_selection(buffer: &Buffer, selection: &Selection, motion: Motion, extend: bool) -> Selection {
    if !extend && !selection.is_empty() {
        match motion {
            Motion::Left => return Selection::cursor(selection.start()),
            Motion::Right => return Selection::cursor(selection.end()),
            _ => {}
        }
    }
    let (head, goal_column) = move_head(buffer, selection, motion);
    let anchor = if extend { selection.anchor } else { head };
    Selection { anchor, head, goal_column }
}

/// Where a motion takes the head, and the goal column it keeps for further vertical moves.
pub(crate) fn move_head(buffer: &Buffer, selection: &Selection, motion: Motion) -> (Position, Option<usize>) {
    let head = selection.head;
    match motion {
        Motion::Left => (position_before(buffer, head), None),
        Motion::Right => (position_after(buffer, head), None),
        Motion::Vertical(rows) => vertical(buffer, selection, rows),
        Motion::LineStart => (Position { row: head.row, column: 0 }, None),
        Motion::LineEnd => (Position { row: head.row, column: buffer.line_length(head.row) }, None),
        Motion::BufferStart => (Position::default(), None),
        Motion::BufferEnd => (buffer.clamp(Position { row: usize::MAX, column: usize::MAX }), None),
        vim_motion => crate::vim::motion::head_for(buffer, selection, vim_motion),
    }
}

/// Up or down by some rows, aiming for the goal column.
pub fn vertical(buffer: &Buffer, selection: &Selection, rows: isize) -> (Position, Option<usize>) {
    let goal = selection.goal_column.unwrap_or(selection.head.column);
    let row = selection.head.row.saturating_add_signed(rows);
    (buffer.clamp(Position { row, column: goal }), Some(goal))
}

/// One character before a position, or the end of the previous line.
fn position_before(buffer: &Buffer, at: Position) -> Position {
    if at.column > 0 {
        return Position { row: at.row, column: at.column - 1 };
    }
    if at.row == 0 {
        return at;
    }
    Position { row: at.row - 1, column: buffer.line_length(at.row - 1) }
}

/// One character after a position, or the start of the next line.
fn position_after(buffer: &Buffer, at: Position) -> Position {
    if at.column < buffer.line_length(at.row) {
        return Position { row: at.row, column: at.column + 1 };
    }
    if at.row + 1 >= buffer.line_count() {
        return at;
    }
    Position { row: at.row + 1, column: 0 }
}

/// The word a position is in or touches, as a selection, or none between words.
pub fn word_at(buffer: &Buffer, at: Position) -> Option<Selection> {
    let characters: Vec<char> = buffer.line(at.row).chars().collect();
    let mut start = at.column.min(characters.len());
    let mut end = start;
    while start > 0 && is_word_character(characters[start - 1]) {
        start -= 1;
    }
    while end < characters.len() && is_word_character(characters[end]) {
        end += 1;
    }
    if start == end {
        return None;
    }
    Some(Selection::spanning(Position { row: at.row, column: start }, Position { row: at.row, column: end }))
}

/// Letters, digits and underscores make up words.
fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// The next place `needle` occurs at or after `from`, wrapping around to the top. Only
/// single-line text is searched for.
pub fn find_next(buffer: &Buffer, needle: &str, from: Position) -> Option<Selection> {
    if needle.is_empty() || needle.contains('\n') {
        return None;
    }
    let line_count = buffer.line_count();
    for step in 0..=line_count {
        let row = (from.row + step) % line_count;
        let skip_columns = if step == 0 { from.column } else { 0 };
        let found = find_in_line(&buffer.line(row), needle, skip_columns);
        if let Some(column) = found {
            let start = Position { row, column };
            let end = Position { row, column: column + needle.chars().count() };
            return Some(Selection::spanning(start, end));
        }
    }
    None
}

/// The column where `needle` first occurs in a line at or after `skip_columns`.
fn find_in_line(line: &str, needle: &str, skip_columns: usize) -> Option<usize> {
    let skip_bytes = line.char_indices().nth(skip_columns).map(|(index, _)| index)?;
    let byte = line[skip_bytes..].find(needle)? + skip_bytes;
    Some(line[..byte].chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn left_and_right_cross_line_ends() {
        let buffer = Buffer::from_text("ab\ncd");
        let moved = move_selection(&buffer, &Selection::cursor(at(1, 0)), Motion::Left, false);
        assert_eq!(moved.head, at(0, 2));
        let moved = move_selection(&buffer, &Selection::cursor(at(0, 2)), Motion::Right, false);
        assert_eq!(moved.head, at(1, 0));
    }

    #[test]
    fn extending_keeps_the_anchor() {
        let buffer = Buffer::from_text("abcd");
        let moved = move_selection(&buffer, &Selection::cursor(at(0, 1)), Motion::LineEnd, true);
        assert_eq!(moved, Selection::spanning(at(0, 1), at(0, 4)));
    }

    #[test]
    fn left_on_a_selection_stops_at_its_start() {
        let buffer = Buffer::from_text("abcd");
        let moved = move_selection(&buffer, &Selection::spanning(at(0, 1), at(0, 3)), Motion::Left, false);
        assert_eq!(moved, Selection::cursor(at(0, 1)));
    }

    #[test]
    fn vertical_moves_keep_the_goal_column() {
        let buffer = Buffer::from_text("abcdef\nab\nabcdef");
        let first = move_selection(&buffer, &Selection::cursor(at(0, 5)), Motion::Vertical(1), false);
        assert_eq!(first.head, at(1, 2));
        let second = move_selection(&buffer, &first, Motion::Vertical(1), false);
        assert_eq!(second.head, at(2, 5));
    }

    #[test]
    fn words_are_found_around_a_position() {
        let buffer = Buffer::from_text("let some_name = 1;");
        assert_eq!(word_at(&buffer, at(0, 6)), Some(Selection::spanning(at(0, 4), at(0, 13))));
        assert_eq!(word_at(&buffer, at(0, 14)), None);
    }

    #[test]
    fn find_next_wraps_around() {
        let buffer = Buffer::from_text("foo bar\nbar foo");
        assert_eq!(find_next(&buffer, "foo", at(0, 1)), Some(Selection::spanning(at(1, 4), at(1, 7))));
        assert_eq!(find_next(&buffer, "foo", at(1, 5)), Some(Selection::spanning(at(0, 0), at(0, 3))));
    }
}
