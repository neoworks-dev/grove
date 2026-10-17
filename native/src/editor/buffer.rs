//! The text being edited, held in a rope so edits and line lookups stay cheap however
//! large the file is.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};

use ropey::Rope;

/// A place in the buffer: a line, and a character within it (not a byte).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub row: usize,
    pub column: usize,
}

pub struct Buffer {
    text: Rope,
    path: Option<PathBuf>,
}

impl Buffer {
    /// An empty buffer with no file behind it.
    pub fn empty() -> Self {
        Buffer { text: Rope::new(), path: None }
    }

    /// Reads a file into a new buffer.
    pub fn open(path: &Path) -> io::Result<Self> {
        let text = Rope::from_reader(BufReader::new(File::open(path)?))?;
        Ok(Buffer { text, path: Some(path.to_path_buf()) })
    }

    /// A buffer holding `text`, for tests.
    #[cfg(test)]
    pub fn from_text(text: &str) -> Self {
        Buffer { text: Rope::from_str(text), path: None }
    }

    /// The file the buffer was read from, if any.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// How many lines there are. A file ending in a newline has an empty last line, which
    /// counts, so the cursor can go there.
    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    /// The text of a line, without its line ending. A row past the end is empty.
    pub fn line(&self, row: usize) -> String {
        if row >= self.line_count() {
            return String::new();
        }
        let mut line = self.text.line(row).to_string();
        let ending = line.len() - line.trim_end_matches(['\n', '\r']).len();
        line.truncate(line.len() - ending);
        line
    }

    /// How many characters a line has, without its line ending.
    pub fn line_length(&self, row: usize) -> usize {
        self.line(row).chars().count()
    }

    /// The text between two positions, line endings included.
    pub fn text_between(&self, start: Position, end: Position) -> String {
        let start_index = self.char_index(start);
        let end_index = self.char_index(end);
        self.text.slice(start_index..end_index).to_string()
    }

    /// The character index in the whole text of a position.
    fn char_index(&self, position: Position) -> usize {
        let position = self.clamp(position);
        self.text.line_to_char(position.row) + position.column
    }

    /// Moves a position onto the nearest place that exists in the buffer.
    pub fn clamp(&self, position: Position) -> Position {
        let last_row = self.line_count().saturating_sub(1);
        let row = position.row.min(last_row);
        Position { row, column: position.column.min(self.line_length(row)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_drop_their_endings() {
        let buffer = Buffer::from_text("one\r\ntwo\nthree");
        assert_eq!(buffer.line_count(), 3);
        assert_eq!(buffer.line(0), "one");
        assert_eq!(buffer.line(1), "two");
        assert_eq!(buffer.line(2), "three");
    }

    #[test]
    fn a_trailing_newline_leaves_an_empty_last_line() {
        let buffer = Buffer::from_text("one\n");
        assert_eq!(buffer.line_count(), 2);
        assert_eq!(buffer.line(1), "");
    }

    #[test]
    fn columns_count_characters_not_bytes() {
        let buffer = Buffer::from_text("größe\n");
        assert_eq!(buffer.line_length(0), 5);
        assert_eq!(buffer.clamp(Position { row: 0, column: 9 }), Position { row: 0, column: 5 });
    }

    #[test]
    fn clamp_keeps_positions_inside_the_buffer() {
        let buffer = Buffer::from_text("ab\ncdef");
        assert_eq!(buffer.clamp(Position { row: 7, column: 7 }), Position { row: 1, column: 4 });
    }
}
