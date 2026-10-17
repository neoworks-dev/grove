//! What the pointer resting on text, or Ctrl-K Ctrl-I at the cursor, shows: the diagnostics on
//! the spot and what the language server says about the symbol there.

use editor_core::{Position, Tone};

use super::completion::is_word_character;
use crate::lsp::Pending;

/// How long the pointer rests before the hover shows, in milliseconds.
pub const HOVER_DELAY_MILLISECONDS: u64 = 450;

/// A diagnostic on the hovered spot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HoverDiagnostic {
    pub tone: Tone,
    pub message: String,
}

/// A hover that is showing, or waiting for the server's answer.
pub struct Hover {
    /// The word or character hovered, which the popover is anchored to and which keeps it open
    /// while the pointer stays on it.
    pub range: (Position, Position),
    pub diagnostics: Vec<HoverDiagnostic>,
    /// What the server said, as markdown.
    pub markdown: Option<String>,
    /// The number of the request whose answer is wanted.
    pub request: u64,
    pub waiting: bool,
    pub pending: Option<Pending>,
}

impl Hover {
    /// Whether there is anything to show yet.
    pub fn has_content(&self) -> bool {
        !self.diagnostics.is_empty() || self.markdown.is_some()
    }

    /// Whether a position is on the hovered word.
    pub fn contains(&self, position: Position) -> bool {
        self.range.0 <= position && position <= self.range.1
    }
}

/// The word the position is in or at the end of, or the single non-blank character there.
/// Nothing for blank space and past the end of a line.
pub fn word_range_at(line: &str, row: usize, column: usize) -> Option<(Position, Position)> {
    let characters: Vec<char> = line.chars().collect();
    let is_word = |index: usize| characters.get(index).is_some_and(|character| is_word_character(*character));
    if is_word(column) {
        let mut start = column;
        while start > 0 && is_word(start - 1) {
            start -= 1;
        }
        let mut end = column;
        while is_word(end) {
            end += 1;
        }
        return Some((Position { row, column: start }, Position { row, column: end }));
    }
    let character = characters.get(column)?;
    if character.is_whitespace() {
        return None;
    }
    Some((Position { row, column }, Position { row, column: column + 1 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn a_word_is_hovered_whole_and_punctuation_alone() {
        assert_eq!(word_range_at("let fooBar = 1", 2, 6), Some((at(2, 4), at(2, 10))));
        assert_eq!(word_range_at("let fooBar = 1", 2, 4), Some((at(2, 4), at(2, 10))));
        assert_eq!(word_range_at("a.b", 0, 1), Some((at(0, 1), at(0, 2))));
    }

    #[test]
    fn blank_space_and_the_end_of_a_line_show_nothing() {
        assert_eq!(word_range_at("a  b", 0, 1), None);
        assert_eq!(word_range_at("ab", 0, 2), None);
        assert_eq!(word_range_at("", 0, 0), None);
    }

    #[test]
    fn the_range_contains_both_ends() {
        let range = (at(0, 4), at(0, 10));
        let hover = Hover { range, diagnostics: Vec::new(), markdown: None, request: 1, waiting: true, pending: None };
        assert!(hover.contains(at(0, 4)) && hover.contains(at(0, 10)));
        assert!(!hover.contains(at(0, 11)) && !hover.contains(at(1, 5)));
        assert!(!hover.has_content());
    }
}
