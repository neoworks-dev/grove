//! The text being edited, held in a rope so edits and line lookups stay cheap however
//! large the file is.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use ropey::Rope;
use serde::{Deserialize, Serialize};

use crate::edit::Edits;

/// A place in the buffer: a line, and a character within it (not a byte).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Position {
    pub row: usize,
    pub column: usize,
}

/// How the file ends its lines. A file that uses `\r\n` is held with `\n` in memory, so every
/// edit and motion deals with one kind of line break, and gets its `\r\n` back when written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineEnding {
    #[default]
    Lf,
    Crlf,
}

/// How many lines at the top of a file are read to tell whether it indents with tabs.
const INDENT_SAMPLE_LINES: usize = 2000;

pub struct Buffer {
    text: Rope,
    path: Option<PathBuf>,
    line_ending: LineEnding,
    indents_with_tabs: bool,
}

impl Buffer {
    /// An empty buffer with no file behind it.
    pub fn empty() -> Self {
        Buffer::with_text("", None)
    }

    /// Reads a file into a new buffer.
    pub fn open(path: &Path) -> io::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Ok(Buffer::with_text(&text, Some(path.to_path_buf())))
    }

    /// A buffer holding `text`, with no file behind it.
    pub fn from_text(text: &str) -> Self {
        Buffer::with_text(text, None)
    }

    /// Builds a buffer, remembering the line ending and indentation the text uses.
    fn with_text(text: &str, path: Option<PathBuf>) -> Self {
        let line_ending = detect_line_ending(text);
        let indents_with_tabs = detect_tab_indentation(text);
        let rope = match line_ending {
            LineEnding::Crlf => Rope::from_str(&text.replace("\r\n", "\n")),
            LineEnding::Lf => Rope::from_str(text),
        };
        Buffer { text: rope, path, line_ending, indents_with_tabs }
    }

    /// The file the buffer was read from, if any.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// How the file ends its lines, which saving keeps.
    pub fn line_ending(&self) -> LineEnding {
        self.line_ending
    }

    /// Whether the file indents with tabs rather than spaces, so Tab inserts one.
    pub fn indents_with_tabs(&self) -> bool {
        self.indents_with_tabs
    }

    /// Writes the text to the file it came from, with the line endings it had. A buffer with
    /// no file refuses.
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Err(io::Error::new(io::ErrorKind::NotFound, "this buffer has no file"));
        };
        let mut writer = BufWriter::new(File::create(path)?);
        for chunk in self.text.chunks() {
            match self.line_ending {
                LineEnding::Lf => writer.write_all(chunk.as_bytes())?,
                LineEnding::Crlf => writer.write_all(chunk.replace('\n', "\r\n").as_bytes())?,
            }
        }
        writer.flush()
    }

    /// How many lines there are. A file ending in a newline has an empty last line, which
    /// counts, so the cursor can go there.
    pub fn line_count(&self) -> usize {
        self.text.len_lines()
    }

    /// How many characters the whole text has.
    pub fn length(&self) -> usize {
        self.text.len_chars()
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
        self.slice(self.offset_of(start)..self.offset_of(end))
    }

    /// The text in a range of character offsets, clamped to the text.
    pub fn slice(&self, range: Range<usize>) -> String {
        let end = range.end.min(self.length());
        let start = range.start.min(end);
        self.text.slice(start..end).to_string()
    }

    /// The character offset in the whole text of a position, which is moved onto the buffer first.
    pub fn offset_of(&self, position: Position) -> usize {
        let position = self.clamp(position);
        self.text.line_to_char(position.row) + position.column
    }

    /// The position of a character offset, which is moved onto the text first.
    pub fn position_of(&self, offset: usize) -> Position {
        let offset = offset.min(self.length());
        let row = self.text.char_to_line(offset);
        let column = offset - self.text.line_to_char(row);
        Position { row, column: column.min(self.line_length(row)) }
    }

    /// The UTF-16 offset of a character offset, which is how input methods count.
    pub fn utf16_of_offset(&self, offset: usize) -> usize {
        self.text.char_to_utf16_cu(offset.min(self.length()))
    }

    /// The character offset of a UTF-16 offset.
    pub fn offset_of_utf16(&self, utf16: usize) -> usize {
        let end = self.text.char_to_utf16_cu(self.length());
        self.text.utf16_cu_to_char(utf16.min(end))
    }

    /// Applies edits, and returns the edits that undo them, described against the new text.
    pub fn apply_edits(&mut self, edits: &Edits) -> Edits {
        let inverse = self.inverse_of(edits);
        // Back to front, so the offsets of the edits not yet applied stay valid.
        for edit in edits.iter().rev() {
            self.text.remove(edit.start..edit.end);
            self.text.insert(edit.start, &edit.text);
        }
        inverse
    }

    /// The edits that put back the text `edits` replaces, in the coordinates of the text after them.
    fn inverse_of(&self, edits: &Edits) -> Edits {
        let replaced = edits.replacement_ranges();
        let undoing = edits
            .iter()
            .zip(replaced)
            .map(|(edit, range)| crate::edit::Edit::replace(range, self.text.slice(edit.start..edit.end).to_string()));
        Edits::new(undoing.collect())
    }

    /// Moves a position onto the nearest place that exists in the buffer.
    pub fn clamp(&self, position: Position) -> Position {
        let last_row = self.line_count().saturating_sub(1);
        let row = position.row.min(last_row);
        Position { row, column: position.column.min(self.line_length(row)) }
    }
}

/// `\r\n` when most of the file's line breaks are one, else `\n`.
fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let breaks = text.matches('\n').count();
    if crlf > 0 && crlf * 2 >= breaks {
        return LineEnding::Crlf;
    }
    LineEnding::Lf
}

/// Whether more of the file's indented lines start with a tab than with a space.
fn detect_tab_indentation(text: &str) -> bool {
    let mut tabs = 0;
    let mut spaces = 0;
    for line in text.lines().take(INDENT_SAMPLE_LINES) {
        if line.starts_with('\t') {
            tabs += 1;
        } else if line.starts_with(' ') {
            spaces += 1;
        }
    }
    tabs > spaces
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
