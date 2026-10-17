//! The text being edited, held in a rope so edits and line lookups stay cheap however
//! large the file is.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};

use ropey::Rope;
use serde::{Deserialize, Serialize};

use crate::edit::Edits;
use crate::indent::{IndentSource, IndentStyle, detect_indent};

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

/// A place in the text as a line and a byte within it, which is how tree-sitter counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BytePoint {
    pub row: usize,
    pub column: usize,
}

/// One replacement in the text, in bytes. Changes come in the order they were made, each
/// described against the text as it was after the ones before it, which is the order a
/// syntax tree is told about them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextChange {
    pub start_byte: usize,
    pub old_end_byte: usize,
    pub new_end_byte: usize,
    pub start_point: BytePoint,
    pub old_end_point: BytePoint,
    pub new_end_point: BytePoint,
}

/// A place in the text as a line and a UTF-16 unit within it, which is how language servers
/// count columns.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Utf16Point {
    pub line: usize,
    pub character: usize,
}

/// One replacement in the text, in the line and UTF-16 column terms of a language server. Like
/// [`TextChange`], changes come in the order they were made and each is described against the
/// text as it was after the ones before it, which is the order a server applies them in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentChange {
    pub start: Utf16Point,
    pub end: Utf16Point,
    pub text: String,
}

pub struct Buffer {
    text: Rope,
    path: Option<PathBuf>,
    line_ending: LineEnding,
    indent: IndentStyle,
    indent_source: IndentSource,
    /// Changes made since the syntax tree last caught up with the text.
    pending_changes: Vec<TextChange>,
    /// Changes made since whoever keeps a language server in step last took them.
    content_changes: Vec<ContentChange>,
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

    /// A buffer holding `text` that is named like `path` without having been read from it, so the
    /// name still says what language the text is.
    pub fn from_text_named(text: &str, path: &Path) -> Self {
        Buffer::with_text(text, Some(path.to_path_buf()))
    }

    /// Builds a buffer, remembering the line ending and indentation the text uses.
    fn with_text(text: &str, path: Option<PathBuf>) -> Self {
        let line_ending = detect_line_ending(text);
        let (indent, indent_source) = match detect_indent(text) {
            Some(detected) => (detected, IndentSource::Detected),
            None => (IndentStyle::default(), IndentSource::Default),
        };
        let rope = match line_ending {
            LineEnding::Crlf => Rope::from_str(&text.replace("\r\n", "\n")),
            LineEnding::Lf => Rope::from_str(text),
        };
        Buffer {
            text: rope,
            path,
            line_ending,
            indent,
            indent_source,
            pending_changes: Vec::new(),
            content_changes: Vec::new(),
        }
    }

    /// The file the buffer was read from, if any.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// How the file ends its lines, which saving keeps.
    pub fn line_ending(&self) -> LineEnding {
        self.line_ending
    }

    /// How the file is indented, which Tab, Enter and vim's shifts follow.
    pub fn indent(&self) -> IndentStyle {
        self.indent
    }

    /// Where the indentation style came from: the file's own lines, the default, or a choice.
    pub fn indent_source(&self) -> IndentSource {
        self.indent_source
    }

    /// Sets how the file is indented, and where that came from.
    pub fn set_indent(&mut self, style: IndentStyle, source: IndentSource) {
        self.indent = style;
        self.indent_source = source;
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
            self.pending_changes.push(self.change_for(edit));
            self.content_changes.push(self.content_change_for(edit));
            self.text.remove(edit.start..edit.end);
            self.text.insert(edit.start, &edit.text);
        }
        inverse
    }

    /// Hands over the changes made since the last call, oldest first.
    pub fn take_changes(&mut self) -> Vec<TextChange> {
        std::mem::take(&mut self.pending_changes)
    }

    /// Hands over the changes made since the last call, for a language server that is kept in
    /// step with the text. Oldest first.
    pub fn take_content_changes(&mut self) -> Vec<ContentChange> {
        std::mem::take(&mut self.content_changes)
    }

    /// The line and UTF-16 column of a character offset.
    pub fn utf16_point_of(&self, offset: usize) -> Utf16Point {
        let offset = offset.min(self.length());
        let line = self.text.char_to_line(offset);
        let line_start = self.text.line_to_char(line);
        let character = self.text.char_to_utf16_cu(offset) - self.text.char_to_utf16_cu(line_start);
        Utf16Point { line, character }
    }

    /// The character offset of a line and UTF-16 column. A line past the end is the end of the
    /// text and a column past the end of its line is the end of the line, as servers expect.
    pub fn offset_of_utf16_point(&self, point: Utf16Point) -> usize {
        if point.line >= self.line_count() {
            return self.length();
        }
        let line_start = self.text.line_to_char(point.line);
        let line_start_utf16 = self.text.char_to_utf16_cu(line_start);
        let line_end_utf16 = self.text.char_to_utf16_cu(line_start + self.line_length(point.line));
        let utf16 = (line_start_utf16 + point.character).min(line_end_utf16);
        self.text.utf16_cu_to_char(utf16)
    }

    /// The text as a rope, for readers that walk it in chunks without copying it.
    pub fn rope(&self) -> &Rope {
        &self.text
    }

    /// Describes an edit in bytes, against the text as it is right now.
    fn change_for(&self, edit: &crate::edit::Edit) -> TextChange {
        let start_byte = self.text.char_to_byte(edit.start);
        let old_end_byte = self.text.char_to_byte(edit.end);
        let start_point = self.byte_point_of(start_byte);
        let old_end_point = self.byte_point_of(old_end_byte);
        TextChange {
            start_byte,
            old_end_byte,
            new_end_byte: start_byte + edit.text.len(),
            start_point,
            old_end_point,
            new_end_point: point_after(start_point, &edit.text),
        }
    }

    /// Describes an edit in a language server's terms, against the text as it is right now.
    fn content_change_for(&self, edit: &crate::edit::Edit) -> ContentChange {
        ContentChange {
            start: self.utf16_point_of(edit.start),
            end: self.utf16_point_of(edit.end),
            text: edit.text.clone(),
        }
    }

    /// The line and byte within it of a byte offset.
    pub fn byte_point_of(&self, byte: usize) -> BytePoint {
        let row = self.text.byte_to_line(byte);
        BytePoint { row, column: byte - self.text.line_to_byte(row) }
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

/// Where the end of `text` lands when it is written starting at `start`.
fn point_after(start: BytePoint, text: &str) -> BytePoint {
    let Some(last_newline) = text.rfind('\n') else {
        return BytePoint { row: start.row, column: start.column + text.len() };
    };
    let newlines = text.matches('\n').count();
    BytePoint { row: start.row + newlines, column: text.len() - last_newline - 1 }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::Edit;

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
    fn utf16_points_count_units_of_a_line_not_characters() {
        let buffer = Buffer::from_text("a😀b\nöx");
        assert_eq!(buffer.utf16_point_of(2), Utf16Point { line: 0, character: 3 });
        assert_eq!(buffer.utf16_point_of(4), Utf16Point { line: 1, character: 0 });
        assert_eq!(buffer.utf16_point_of(6), Utf16Point { line: 1, character: 2 });
        assert_eq!(buffer.offset_of_utf16_point(Utf16Point { line: 0, character: 3 }), 2);
        assert_eq!(buffer.offset_of_utf16_point(Utf16Point { line: 1, character: 1 }), 5);
    }

    #[test]
    fn utf16_points_past_the_end_land_on_the_end() {
        let buffer = Buffer::from_text("ab\ncd");
        assert_eq!(buffer.offset_of_utf16_point(Utf16Point { line: 0, character: 99 }), 2);
        assert_eq!(buffer.offset_of_utf16_point(Utf16Point { line: 9, character: 0 }), 5);
    }

    #[test]
    fn edits_are_recorded_for_a_server_in_the_order_it_applies_them() {
        let mut buffer = Buffer::from_text("😀 one\ntwo\n");
        let edits = Edits::new(vec![Edit::replace(2..5, "1"), Edit::replace(6..9, "2\n3")]);
        buffer.apply_edits(&edits);
        let changes = buffer.take_content_changes();
        assert_eq!(changes.len(), 2);
        // The later edit goes first so the earlier one's range is still valid.
        assert_eq!(changes[0].start, Utf16Point { line: 1, character: 0 });
        assert_eq!(changes[0].end, Utf16Point { line: 1, character: 3 });
        assert_eq!(changes[0].text, "2\n3");
        assert_eq!(changes[1].start, Utf16Point { line: 0, character: 3 });
        assert_eq!(changes[1].end, Utf16Point { line: 0, character: 6 });
        assert!(buffer.take_content_changes().is_empty());
    }

    #[test]
    fn clamp_keeps_positions_inside_the_buffer() {
        let buffer = Buffer::from_text("ab\ncdef");
        assert_eq!(buffer.clamp(Position { row: 7, column: 7 }), Position { row: 1, column: 4 });
    }
}
