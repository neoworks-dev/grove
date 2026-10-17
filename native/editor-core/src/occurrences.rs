//! Occurrences of the word under the cursor, for the view to show as quiet highlights. This
//! matches the word as text, which works in every language. A language server can answer better
//! (it knows which places are the same symbol): while it has decorations of [`SERVER_SOURCE`] on a
//! document, the view leaves the text matching to it and marks nothing under [`SOURCE`].

use std::ops::Range;

use crate::buffer::{Buffer, Position};
use crate::decorations::{Decoration, DecorationKind, Tone};
use crate::movement::word_at;

/// The decoration source the occurrences matched as text are kept under.
pub const SOURCE: &str = "illuminate";

/// The decoration source a language server's document highlights go under, which takes the place
/// of the text matching while it has any.
pub const SERVER_SOURCE: &str = "lsp.documentHighlight";

/// The most occurrences marked, so a word that fills a file does not fill the frame.
const MAX_OCCURRENCES: usize = 500;

/// Lines longer than this are not searched, which keeps minified files from stalling a frame.
const MAX_LINE_CHARACTERS: usize = 2000;

/// The word the cursor is in or touches.
pub fn word_under(buffer: &Buffer, cursor: Position) -> Option<String> {
    let word = word_at(buffer, cursor)?;
    let line = buffer.line(cursor.row);
    Some(line.chars().skip(word.start().column).take(word.end().column - word.start().column).collect())
}

/// The decorations that mark every other place the word under `cursor` appears as a whole word, in
/// the `rows` given. None when the cursor is not on a word.
pub fn occurrence_decorations(buffer: &Buffer, cursor: Position, rows: Range<usize>) -> Vec<Decoration> {
    let Some(word) = word_under(buffer, cursor) else {
        return Vec::new();
    };
    let own_start = word_at(buffer, cursor).map(|selection| selection.start());
    let mut decorations = Vec::new();
    for row in rows.start..rows.end.min(buffer.line_count()) {
        let line = buffer.line(row);
        if line.len() > MAX_LINE_CHARACTERS {
            continue;
        }
        for column in whole_word_columns(&line, &word) {
            if own_start == Some(Position { row, column }) {
                continue;
            }
            decorations.push(occurrence_at(row, column, word.chars().count()));
            if decorations.len() >= MAX_OCCURRENCES {
                return decorations;
            }
        }
    }
    decorations
}

/// A highlight over `length` characters at a place.
fn occurrence_at(row: usize, column: usize, length: usize) -> Decoration {
    Decoration {
        start: Position { row, column },
        end: Some(Position { row, column: column + length }),
        tooltip: None,
        kind: DecorationKind::Highlight { background: Some(Tone::Occurrence), underline: None },
    }
}

/// The columns where `word` appears in `line` with no word character on either side.
fn whole_word_columns(line: &str, word: &str) -> Vec<usize> {
    let mut columns = Vec::new();
    for (byte, _) in line.match_indices(word) {
        let before = line[..byte].chars().next_back();
        let after = line[byte + word.len()..].chars().next();
        if before.is_some_and(is_word_character) || after.is_some_and(is_word_character) {
            continue;
        }
        columns.push(line[..byte].chars().count());
    }
    columns
}

/// Letters, digits and underscores make up words, as everywhere else in the editor.
fn is_word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn starts(decorations: &[Decoration]) -> Vec<Position> {
        decorations.iter().map(|decoration| decoration.start).collect()
    }

    #[test]
    fn every_other_whole_word_match_in_the_rows_is_marked() {
        let buffer = Buffer::from_text("let size = 1;\nsize += size2;\nreturn size;\n");
        let found = occurrence_decorations(&buffer, at(0, 5), 0..3);
        assert_eq!(starts(&found), vec![at(1, 0), at(2, 7)]);
        assert_eq!(found[0].end, Some(at(1, 4)));
    }

    #[test]
    fn the_word_under_the_cursor_is_not_marked_and_parts_of_longer_words_are_not_matches() {
        let buffer = Buffer::from_text("size resize sizes size");
        let found = occurrence_decorations(&buffer, at(0, 0), 0..1);
        assert_eq!(starts(&found), vec![at(0, 18)]);
    }

    #[test]
    fn a_cursor_touching_the_end_of_a_word_counts_as_on_it() {
        let buffer = Buffer::from_text("name + name");
        assert_eq!(starts(&occurrence_decorations(&buffer, at(0, 4), 0..1)), vec![at(0, 7)]);
    }

    #[test]
    fn only_the_rows_asked_for_are_searched() {
        let buffer = Buffer::from_text("a\na\na\na\n");
        assert_eq!(starts(&occurrence_decorations(&buffer, at(0, 0), 1..3)), vec![at(1, 0), at(2, 0)]);
    }

    #[test]
    fn a_cursor_between_words_marks_nothing() {
        let buffer = Buffer::from_text("a  a");
        assert!(occurrence_decorations(&buffer, at(0, 2), 0..1).is_empty());
    }

    #[test]
    fn columns_count_characters_not_bytes() {
        let buffer = Buffer::from_text("größe x größe");
        assert_eq!(starts(&occurrence_decorations(&buffer, at(0, 1), 0..1)), vec![at(0, 8)]);
    }

    #[test]
    fn the_marks_are_capped() {
        let buffer = Buffer::from_text(&"a\n".repeat(2000));
        assert_eq!(occurrence_decorations(&buffer, at(0, 0), 0..2000).len(), MAX_OCCURRENCES);
    }
}
