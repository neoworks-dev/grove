//! Where vim's motions take the cursor, worked out from the text alone. Words, paragraphs,
//! matching brackets and finding a character are here; the editor state turns what they find
//! into a moved cursor, or into the range an operator acts on.

use ropey::Rope;

use crate::buffer::{Buffer, Position};
use crate::movement::Motion;
use crate::selections::Selection;

/// How far an operator reaches when it is given a motion: whether the character the motion
/// lands on is part of what it covers, and whether it takes whole lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionKind {
    /// The text up to the landing place, not including its character.
    Exclusive,
    /// The text up to and including the landing character.
    Inclusive,
    /// Every line from the cursor's to the landing place's.
    Linewise,
}

/// Where a motion lands, and how an operator treats the way there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reach {
    pub position: Position,
    /// The column further up and down moves aim for.
    pub goal_column: Option<usize>,
    pub kind: MotionKind,
}

/// The character at an offset, or none past the end.
fn char_at(text: &Rope, offset: usize) -> Option<char> {
    text.get_char(offset)
}

/// Letters, digits and underscores make up words.
pub fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// 0 for white space, and otherwise a number that is the same for characters that make up one
/// word. With `big`, everything that is not white space is one class, as `W`, `B` and `E` see it.
fn class_of(character: char, big: bool) -> u8 {
    if character.is_whitespace() {
        return 0;
    }
    if big || is_word_character(character) {
        return 1;
    }
    2
}

/// The class of the character at an offset, where the end of the text counts as white space.
fn class_at(text: &Rope, offset: usize, big: bool) -> u8 {
    match char_at(text, offset) {
        Some(character) => class_of(character, big),
        None => 0,
    }
}

/// Whether the line break at this offset belongs to an empty line, which counts as a word.
fn is_empty_line_break(text: &Rope, offset: usize) -> bool {
    if char_at(text, offset) != Some('\n') {
        return false;
    }
    offset == 0 || char_at(text, offset - 1) == Some('\n')
}

/// Where `w` goes: the start of the next word. With `stop_at_line_end` it stops at the end of
/// the line instead of crossing it, which is what an operator does on the last word of a line.
pub fn word_forward(text: &Rope, from: usize, big: bool, stop_at_line_end: bool) -> usize {
    let length = text.len_chars();
    let mut offset = from;
    if offset >= length {
        return length;
    }
    let starting_class = class_at(text, offset, big);
    if starting_class != 0 {
        while offset < length && class_at(text, offset, big) == starting_class {
            offset += 1;
        }
    }
    while offset < length {
        let character = char_at(text, offset).unwrap_or(' ');
        if class_of(character, big) != 0 {
            break;
        }
        if character == '\n' {
            if stop_at_line_end && offset > from {
                return offset;
            }
            if stop_at_line_end && is_empty_line_break(text, offset) {
                return offset;
            }
            if char_at(text, offset + 1) == Some('\n') {
                return offset + 1;
            }
        }
        offset += 1;
    }
    offset
}

/// Where `e` goes: the last character of the current word, or of the next one when the cursor
/// is already on a word's last character.
pub fn word_end(text: &Rope, from: usize, big: bool) -> usize {
    let length = text.len_chars();
    let mut offset = from + 1;
    while offset < length && class_at(text, offset, big) == 0 {
        offset += 1;
    }
    if offset >= length {
        return length.saturating_sub(1).max(from);
    }
    let word_class = class_at(text, offset, big);
    while offset + 1 < length && class_at(text, offset + 1, big) == word_class {
        offset += 1;
    }
    offset
}

/// Where `b` goes: the start of the current word, or of the one before when already at a start.
pub fn word_back(text: &Rope, from: usize, big: bool) -> usize {
    if from == 0 {
        return 0;
    }
    let mut offset = from - 1;
    loop {
        if class_at(text, offset, big) != 0 || is_empty_line_break(text, offset) || offset == 0 {
            break;
        }
        offset -= 1;
    }
    let word_class = class_at(text, offset, big);
    if word_class == 0 {
        return offset;
    }
    while offset > 0 && class_at(text, offset - 1, big) == word_class {
        offset -= 1;
    }
    offset
}

/// Where `ge` goes: the last character of the word before the cursor.
pub fn word_end_back(text: &Rope, from: usize, big: bool) -> usize {
    if from == 0 {
        return 0;
    }
    let mut offset = from;
    let current_class = class_at(text, offset, big);
    if current_class != 0 {
        while offset > 0 && class_at(text, offset - 1, big) == current_class {
            offset -= 1;
        }
    }
    if offset == 0 {
        return 0;
    }
    offset -= 1;
    loop {
        if class_at(text, offset, big) != 0 || is_empty_line_break(text, offset) || offset == 0 {
            break;
        }
        offset -= 1;
    }
    offset
}

/// The last character of the word the cursor is on, or where `w` goes from white space, as
/// `cw` treats it: unlike `dw`, changing a word leaves the white space after it alone. Each
/// further count takes the word after.
pub fn change_word_end(text: &Rope, from: usize, big: bool, count: usize) -> usize {
    let mut offset = from;
    for step in 0..count {
        if step > 0 {
            offset = word_forward(text, offset, big, false);
        }
        let word_class = class_at(text, offset, big);
        if word_class == 0 {
            continue;
        }
        while class_at(text, offset + 1, big) == word_class {
            offset += 1;
        }
    }
    offset
}

/// How many characters of leading white space a line has, kept on the line's last character.
pub fn first_non_blank_column(line: &str) -> usize {
    let indentation = line.chars().take_while(|character| character.is_whitespace()).count();
    indentation.min(line.chars().count().saturating_sub(1))
}

/// The row `}` or `{` lands on, counting from `row`.
fn paragraph_row(buffer: &Buffer, row: usize, forward: bool) -> usize {
    let last_row = buffer.line_count().saturating_sub(1);
    let is_blank = |candidate: usize| buffer.line_length(candidate) == 0;
    let mut current = row;
    let step =
        |current: usize| if forward { (current < last_row).then(|| current + 1) } else { current.checked_sub(1) };
    while is_blank(current) {
        match step(current) {
            Some(next) => current = next,
            None => return current,
        }
    }
    while !is_blank(current) {
        match step(current) {
            Some(next) => current = next,
            None => return current,
        }
    }
    current
}

/// The bracket that closes or opens another, and whether the other is further on.
fn matching_bracket(character: char) -> Option<(char, bool)> {
    match character {
        '(' => Some((')', true)),
        '[' => Some((']', true)),
        '{' => Some(('}', true)),
        ')' => Some(('(', false)),
        ']' => Some(('[', false)),
        '}' => Some(('{', false)),
        _ => None,
    }
}

/// The offset of the bracket matching the first bracket at or after the cursor on its line.
fn matching_bracket_offset(buffer: &Buffer, head: Position) -> Option<usize> {
    let text = buffer.rope();
    let line_end = buffer.offset_of(Position { row: head.row, column: usize::MAX });
    let mut start = buffer.offset_of(head);
    while start < line_end && matching_bracket(char_at(text, start)?).is_none() {
        start += 1;
    }
    let (partner, forward) = matching_bracket(char_at(text, start)?)?;
    let own = char_at(text, start)?;
    let mut depth = 0usize;
    let mut offset = start;
    loop {
        let character = char_at(text, offset)?;
        if character == own {
            depth += 1;
        } else if character == partner {
            depth -= 1;
            if depth == 0 {
                return Some(offset);
            }
        }
        if forward {
            offset += 1;
            if offset >= text.len_chars() {
                return None;
            }
            continue;
        }
        offset = offset.checked_sub(1)?;
    }
}

/// The column of the `count`th `character` on the line, looking forward or back from the
/// cursor. `till` stops one short of it, and `repeat` makes a till skip a match right next to
/// the cursor, so `;` after `t` goes on to the next one.
fn find_in_line(
    line: &str,
    column: usize,
    character: char,
    forward: bool,
    till: bool,
    repeat: bool,
    count: usize,
) -> Option<usize> {
    let characters: Vec<char> = line.chars().collect();
    let mut remaining = count;
    let mut skip_adjacent = repeat && till;
    let mut candidate = column;
    loop {
        candidate = if forward { candidate + 1 } else { candidate.checked_sub(1)? };
        if candidate >= characters.len() {
            return None;
        }
        if characters[candidate] != character {
            continue;
        }
        let adjacent = candidate.abs_diff(column) == 1;
        if skip_adjacent && adjacent {
            skip_adjacent = false;
            continue;
        }
        remaining -= 1;
        if remaining > 0 {
            continue;
        }
        if !till {
            return Some(candidate);
        }
        if forward {
            return Some(candidate - 1);
        }
        return Some(candidate + 1);
    }
}

/// Where a motion takes the selection's head when it is made `count` times, or none when it
/// cannot be made, which cancels an operator waiting for it. `for_operator` is set when an
/// operator is waiting, which changes how `w` treats the end of a line.
pub fn reach(
    buffer: &Buffer,
    selection: &Selection,
    motion: Motion,
    count: usize,
    for_operator: bool,
) -> Option<Reach> {
    let count = count.max(1);
    let head = selection.head;
    let text = buffer.rope();
    let offset = buffer.offset_of(head);
    let last_row = buffer.line_count().saturating_sub(1);
    let exclusive = |position: Position| Some(Reach { position, goal_column: None, kind: MotionKind::Exclusive });
    let inclusive = |position: Position| Some(Reach { position, goal_column: None, kind: MotionKind::Inclusive });
    match motion {
        Motion::Left | Motion::Right | Motion::BufferStart | Motion::BufferEnd => {
            let mut position = head;
            for _ in 0..count {
                position = crate::movement::move_head(buffer, &Selection::cursor(position), motion).0;
            }
            exclusive(position)
        }
        Motion::ColumnLeft => {
            if head.column == 0 {
                return None;
            }
            exclusive(Position { row: head.row, column: head.column.saturating_sub(count) })
        }
        Motion::AfterCursor => {
            let length = buffer.line_length(head.row);
            exclusive(Position { row: head.row, column: (head.column + 1).min(length) })
        }
        Motion::ColumnRight => {
            let length = buffer.line_length(head.row);
            if head.column >= length {
                return None;
            }
            exclusive(Position { row: head.row, column: (head.column + count).min(length) })
        }
        Motion::Vertical(rows) => {
            let goal = selection.goal_column.unwrap_or(head.column);
            let moved = rows.saturating_mul(count as isize);
            let row = head.row.saturating_add_signed(moved).min(last_row);
            if row == head.row && rows != 0 {
                return None;
            }
            let position = buffer.clamp(Position { row, column: goal });
            Some(Reach { position, goal_column: Some(goal), kind: MotionKind::Linewise })
        }
        Motion::LineStart => exclusive(Position { row: head.row, column: 0 }),
        Motion::LineEnd => {
            let row = (head.row + count - 1).min(last_row);
            let position = Position { row, column: buffer.line_length(row).saturating_sub(1) };
            Some(Reach { position, goal_column: Some(usize::MAX), kind: MotionKind::Inclusive })
        }
        Motion::FirstNonBlank => {
            exclusive(Position { row: head.row, column: first_non_blank_column(&buffer.line(head.row)) })
        }
        Motion::LastNonBlank => {
            let row = (head.row + count - 1).min(last_row);
            let line = buffer.line(row);
            let trimmed = line.trim_end().chars().count();
            inclusive(Position { row, column: trimmed.saturating_sub(1) })
        }
        Motion::To(position) => exclusive(buffer.clamp(position)),
        Motion::Line(target) => {
            let row = target.min(last_row);
            let column = first_non_blank_column(&buffer.line(row));
            Some(Reach { position: Position { row, column }, goal_column: None, kind: MotionKind::Linewise })
        }
        Motion::WordForward { big } => {
            let mut landing = offset;
            for step in 0..count {
                let last_step = step + 1 == count;
                landing = word_forward(text, landing, big, for_operator && last_step);
            }
            exclusive(buffer.position_of(landing))
        }
        Motion::WordEnd { big } => {
            let mut landing = offset;
            for _ in 0..count {
                landing = word_end(text, landing, big);
            }
            inclusive(buffer.position_of(landing))
        }
        Motion::WordBack { big } => {
            let mut landing = offset;
            for _ in 0..count {
                landing = word_back(text, landing, big);
            }
            exclusive(buffer.position_of(landing))
        }
        Motion::WordEndBack { big } => {
            let mut landing = offset;
            for _ in 0..count {
                landing = word_end_back(text, landing, big);
            }
            inclusive(buffer.position_of(landing))
        }
        Motion::ParagraphForward | Motion::ParagraphBack => {
            let forward = motion == Motion::ParagraphForward;
            let mut row = head.row;
            for _ in 0..count {
                row = paragraph_row(buffer, row, forward);
            }
            let ends_on_text = row == last_row && buffer.line_length(row) > 0 && forward;
            if ends_on_text {
                return exclusive(Position { row, column: buffer.line_length(row) });
            }
            exclusive(Position { row, column: 0 })
        }
        Motion::MatchingBracket => {
            let found = matching_bracket_offset(buffer, head)?;
            inclusive(buffer.position_of(found))
        }
        Motion::FindChar { character, forward, till, repeat } => {
            let line = buffer.line(head.row);
            let column = find_in_line(&line, head.column, character, forward, till, repeat, count)?;
            let position = Position { row: head.row, column };
            if forward { inclusive(position) } else { exclusive(position) }
        }
    }
}

/// The new head for a motion made once, the way a plain move makes it, and the goal column it
/// keeps. A motion that cannot be made leaves the head where it is.
pub fn head_for(buffer: &Buffer, selection: &Selection, motion: Motion) -> (Position, Option<usize>) {
    match reach(buffer, selection, motion, 1, false) {
        Some(reached) => (reached.position, reached.goal_column),
        None => (selection.head, selection.goal_column),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn landing(text: &str, from: Position, motion: Motion, count: usize) -> Option<Position> {
        let buffer = Buffer::from_text(text);
        reach(&buffer, &Selection::cursor(from), motion, count, false).map(|reached| reached.position)
    }

    #[test]
    fn w_goes_to_the_next_word_across_punctuation_and_lines() {
        let word = Motion::WordForward { big: false };
        assert_eq!(landing("foo.bar baz", at(0, 0), word, 1), Some(at(0, 3)));
        assert_eq!(landing("foo.bar baz", at(0, 3), word, 1), Some(at(0, 4)));
        assert_eq!(landing("foo\n  bar", at(0, 0), word, 1), Some(at(1, 2)));
        assert_eq!(landing("a b c d", at(0, 0), word, 3), Some(at(0, 6)));
    }

    #[test]
    fn big_w_skips_punctuation_inside_a_word() {
        let word = Motion::WordForward { big: true };
        assert_eq!(landing("foo.bar baz", at(0, 0), word, 1), Some(at(0, 8)));
    }

    #[test]
    fn empty_lines_are_words() {
        let word = Motion::WordForward { big: false };
        assert_eq!(landing("foo\n\nbar", at(0, 0), word, 1), Some(at(1, 0)));
        assert_eq!(landing("foo\n\nbar", at(1, 0), word, 1), Some(at(2, 0)));
    }

    #[test]
    fn e_and_b_and_ge_move_to_word_ends_and_starts() {
        let end = Motion::WordEnd { big: false };
        assert_eq!(landing("foo bar", at(0, 0), end, 1), Some(at(0, 2)));
        assert_eq!(landing("foo bar", at(0, 2), end, 1), Some(at(0, 6)));
        let back = Motion::WordBack { big: false };
        assert_eq!(landing("foo bar", at(0, 6), back, 1), Some(at(0, 4)));
        assert_eq!(landing("foo bar", at(0, 4), back, 1), Some(at(0, 0)));
        let end_back = Motion::WordEndBack { big: false };
        assert_eq!(landing("foo bar", at(0, 5), end_back, 1), Some(at(0, 2)));
    }

    #[test]
    fn paragraphs_stop_on_empty_lines() {
        assert_eq!(landing("a\nb\n\nc\nd", at(0, 0), Motion::ParagraphForward, 1), Some(at(2, 0)));
        assert_eq!(landing("a\nb\n\nc\nd", at(2, 0), Motion::ParagraphForward, 1), Some(at(4, 1)));
        assert_eq!(landing("a\nb\n\nc\nd", at(4, 0), Motion::ParagraphBack, 1), Some(at(2, 0)));
    }

    #[test]
    fn percent_matches_brackets_across_lines() {
        assert_eq!(landing("f(a, (b))", at(0, 1), Motion::MatchingBracket, 1), Some(at(0, 8)));
        assert_eq!(landing("{\n  x\n}", at(0, 0), Motion::MatchingBracket, 1), Some(at(2, 0)));
        assert_eq!(landing("{\n  x\n}", at(2, 0), Motion::MatchingBracket, 1), Some(at(0, 0)));
        assert_eq!(landing("plain", at(0, 0), Motion::MatchingBracket, 1), None);
    }

    #[test]
    fn find_and_till_look_along_the_line() {
        let find = |forward, till, repeat| Motion::FindChar { character: 'o', forward, till, repeat };
        assert_eq!(landing("foo boo", at(0, 0), find(true, false, false), 1), Some(at(0, 1)));
        assert_eq!(landing("foo boo", at(0, 0), find(true, false, false), 3), Some(at(0, 5)));
        assert_eq!(landing("foo boo", at(0, 0), find(true, true, false), 1), Some(at(0, 0)));
        assert_eq!(landing("foo boo", at(0, 0), find(true, true, true), 1), Some(at(0, 1)));
        assert_eq!(landing("foo boo", at(0, 6), find(false, false, false), 1), Some(at(0, 5)));
        assert_eq!(landing("foo boo", at(0, 6), find(false, true, false), 2), Some(at(0, 3)));
        assert_eq!(landing("foo", at(0, 0), find(true, false, false), 5), None);
    }

    #[test]
    fn first_non_blank_and_line_ends() {
        assert_eq!(landing("   foo", at(0, 5), Motion::FirstNonBlank, 1), Some(at(0, 3)));
        assert_eq!(landing("   foo\nbar", at(0, 0), Motion::LineEnd, 1), Some(at(0, 5)));
        assert_eq!(landing("   foo\nbar", at(0, 0), Motion::LineEnd, 2), Some(at(1, 2)));
        assert_eq!(landing("a\n  b", at(0, 0), Motion::Line(1), 1), Some(at(1, 2)));
    }

    #[test]
    fn a_motion_that_cannot_be_made_has_no_landing() {
        assert_eq!(landing("one", at(0, 0), Motion::Vertical(1), 1), None);
        assert_eq!(landing("one", at(0, 0), Motion::ColumnLeft, 1), None);
        assert_eq!(landing("", at(0, 0), Motion::ColumnRight, 1), None);
    }
}
