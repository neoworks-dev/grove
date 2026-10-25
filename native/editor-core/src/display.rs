//! How a buffer line is drawn: tabs become spaces up to the next tab stop, and each
//! character of the line keeps its place in the drawn text so the cursor and the pointer
//! can be mapped between the two. Inlays widen a line, and blocks add rows between lines.

use std::ops::Range;

/// Columns between tab stops.
pub const TAB_WIDTH: usize = 4;

/// Text an inlay adds to a line, before the character at `column`.
#[derive(Clone, Copy, Debug)]
pub struct InlayText<'a> {
    pub column: usize,
    pub text: &'a str,
}

pub struct DisplayLine {
    /// The text as it is shaped and painted, inlays included.
    pub text: String,
    /// The byte offset in `text` of the cursor at each column of the buffer line, with one more
    /// entry for the end of the line. A cursor sits before the inlays at its column.
    starts: Vec<usize>,
    /// The byte offset in `text` where the character at each column starts, after the inlays
    /// that go before it. The same as `starts` on a line without inlays.
    character_starts: Vec<usize>,
    /// The byte ranges of `text` that are inlays.
    inlay_ranges: Vec<Range<usize>>,
}

impl DisplayLine {
    /// Lays out one buffer line, without its line ending.
    pub fn new(line: &str) -> Self {
        DisplayLine::with_inlays(line, &[])
    }

    /// Lays out one buffer line with inlays in it, which must be ordered by column. Several at
    /// one column go in the order given. Inlays past the end of the line go at its end.
    pub fn with_inlays(line: &str, inlays: &[InlayText]) -> Self {
        let mut layout = LineLayout::default();
        let mut pending = inlays.iter().peekable();
        let mut column = 0;
        for character in line.chars() {
            layout.start_column();
            while let Some(inlay) = pending.next_if(|inlay| inlay.column <= column) {
                layout.push_inlay(inlay.text);
            }
            layout.start_character();
            layout.push_character(character);
            column += 1;
        }
        layout.start_column();
        for inlay in pending {
            layout.push_inlay(inlay.text);
        }
        layout.start_character();
        layout.finish()
    }

    /// The byte offset in the drawn text of the cursor at a buffer column, which is before the
    /// inlays there. Columns past the end of the line land at its end.
    pub fn offset_of(&self, column: usize) -> usize {
        let last = self.starts.len() - 1;
        self.starts[column.min(last)]
    }

    /// Where the left edge of a range that starts at a column is: after the inlays there, so a
    /// highlight begins at the character it starts on.
    pub fn range_start_offset(&self, column: usize) -> usize {
        let last = self.character_starts.len() - 1;
        self.character_starts[column.min(last)]
    }

    /// Where the right edge of a range that ends at a column is. A range that runs past the end
    /// of the line takes in the inlays at its end.
    pub fn range_end_offset(&self, column: usize) -> usize {
        if column >= self.starts.len() - 1 {
            return self.text.len();
        }
        self.starts[column]
    }

    /// The buffer column whose start is at or after a byte offset in the drawn text, so a
    /// point inside a tab lands after it. A point in an inlay, or at its right edge, lands at
    /// the cursor before it, since there is no cursor inside.
    pub fn column_at(&self, offset: usize) -> usize {
        let last = self.starts.len() - 1;
        let column = self.starts.partition_point(|start| *start < offset).min(last);
        if column > 0 && offset <= self.character_starts[column - 1] {
            return column - 1;
        }
        column
    }

    /// The byte ranges of the drawn text that are inlays.
    pub fn inlay_ranges(&self) -> &[Range<usize>] {
        &self.inlay_ranges
    }
}

/// A line being laid out, one character or inlay at a time.
#[derive(Default)]
struct LineLayout {
    text: String,
    display_column: usize,
    starts: Vec<usize>,
    character_starts: Vec<usize>,
    inlay_ranges: Vec<Range<usize>>,
}

impl LineLayout {
    /// Records where the cursor of the next column goes.
    fn start_column(&mut self) {
        self.starts.push(self.text.len());
    }

    /// Records where the next column's character starts, after its inlays.
    fn start_character(&mut self) {
        self.character_starts.push(self.text.len());
    }

    /// Adds an inlay's text.
    fn push_inlay(&mut self, text: &str) {
        let start = self.text.len();
        self.text.push_str(text);
        self.display_column += text.chars().count();
        self.inlay_ranges.push(start..self.text.len());
    }

    /// Adds a character of the line, a tab as the spaces up to the next tab stop.
    fn push_character(&mut self, character: char) {
        if character != '\t' {
            self.text.push(character);
            self.display_column += 1;
            return;
        }
        let spaces = TAB_WIDTH - self.display_column % TAB_WIDTH;
        self.text.extend(std::iter::repeat_n(' ', spaces));
        self.display_column += spaces;
    }

    fn finish(self) -> DisplayLine {
        DisplayLine {
            text: self.text,
            starts: self.starts,
            character_starts: self.character_starts,
            inlay_ranges: self.inlay_ranges,
        }
    }
}

/// A block of rows between lines: the buffer row it goes before, and how many rows tall it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockSlot {
    pub slot: usize,
    pub height: usize,
}

/// What a row of the display is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayRow {
    /// A line of the buffer.
    Text(usize),
    /// A row of a block: which one (by its place in the list the map was made from), and which of its rows.
    Block { block: usize, line: usize },
}

/// Where blocks sit among the lines of the buffer. Rows of the display are the buffer's lines with
/// the blocks' rows between them; this maps one numbering to the other, and everything that
/// paints or points in rows (scrolling, clicks, the cursor) goes through it.
#[derive(Clone, Debug, Default)]
pub struct BlockMap {
    spans: Vec<Span>,
}

/// One block in the map.
#[derive(Clone, Copy, Debug)]
struct Span {
    index: usize,
    slot: usize,
    height: usize,
    /// The display row the block's first row is on.
    first_row: usize,
    /// How many block rows there are in all blocks up to and including this one.
    rows_through: usize,
}

impl BlockMap {
    /// A map over blocks, which must be ordered by slot. Blocks of no height are left out.
    pub fn new(blocks: &[BlockSlot]) -> Self {
        let mut spans = Vec::with_capacity(blocks.len());
        let mut rows_before = 0;
        for (index, block) in blocks.iter().enumerate() {
            if block.height == 0 {
                continue;
            }
            spans.push(Span {
                index,
                slot: block.slot,
                height: block.height,
                first_row: block.slot + rows_before,
                rows_through: rows_before + block.height,
            });
            rows_before += block.height;
        }
        BlockMap { spans }
    }

    /// Whether there are no blocks, so display rows are buffer rows.
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// The display row a buffer row is drawn on: after the blocks that go before it.
    pub fn display_row_of(&self, row: usize) -> usize {
        let before = self.spans.partition_point(|span| span.slot <= row);
        match before {
            0 => row,
            _ => row + self.spans[before - 1].rows_through,
        }
    }

    /// The display rows of the block at `index` in the list the map was made from, or none for a
    /// block of no height.
    pub fn rows_of(&self, index: usize) -> Option<std::ops::Range<usize>> {
        let span = self.spans.iter().find(|span| span.index == index)?;
        Some(span.first_row..span.first_row + span.height)
    }

    /// How many display rows there are for a buffer of `line_count` lines.
    pub fn total_rows(&self, line_count: usize) -> usize {
        match self.spans.last() {
            Some(last) => line_count + last.rows_through,
            None => line_count,
        }
    }

    /// What is drawn on a display row. A row past the end is a line past the end of the buffer.
    pub fn row_at(&self, display_row: usize) -> DisplayRow {
        let reached = self.spans.partition_point(|span| span.first_row <= display_row);
        if reached == 0 {
            return DisplayRow::Text(display_row);
        }
        let span = self.spans[reached - 1];
        if display_row < span.first_row + span.height {
            return DisplayRow::Block { block: span.index, line: display_row - span.first_row };
        }
        DisplayRow::Text(display_row - span.rows_through)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_reach_the_next_stop() {
        let line = DisplayLine::new("a\tb\t\tc");
        assert_eq!(line.text, "a   b       c");
        assert_eq!(line.offset_of(2), 4);
        assert_eq!(line.offset_of(5), 12);
    }

    #[test]
    fn offsets_map_back_to_columns() {
        let line = DisplayLine::new("\tx");
        assert_eq!(line.column_at(0), 0);
        assert_eq!(line.column_at(2), 1);
        assert_eq!(line.column_at(4), 1);
        assert_eq!(line.column_at(5), 2);
    }

    #[test]
    fn multibyte_characters_keep_their_offsets() {
        let line = DisplayLine::new("ü\tz");
        assert_eq!(line.text, "ü   z");
        assert_eq!(line.offset_of(1), 2);
        assert_eq!(line.offset_of(2), 5);
        assert_eq!(line.column_at(5), 2);
    }

    fn hint(column: usize, text: &str) -> InlayText<'_> {
        InlayText { column, text }
    }

    #[test]
    fn an_inlay_pushes_the_text_after_it_aside() {
        let line = DisplayLine::with_inlays("let x = 1;", &[hint(5, ": i32")]);
        assert_eq!(line.text, "let x: i32 = 1;");
        assert_eq!(line.inlay_ranges(), &[5..10]);
        // The cursor before the inlay is at the end of `x`; the next one is past it.
        assert_eq!(line.offset_of(5), 5);
        assert_eq!(line.offset_of(6), 11);
        assert_eq!(line.range_start_offset(5), 10);
    }

    #[test]
    fn a_point_in_an_inlay_lands_at_the_cursor_before_it() {
        let line = DisplayLine::with_inlays("let x = 1;", &[hint(5, ": i32")]);
        assert_eq!(line.column_at(5), 5);
        assert_eq!(line.column_at(7), 5);
        assert_eq!(line.column_at(10), 5);
        // Right of the character after the inlay is the cursor after it.
        assert_eq!(line.column_at(11), 6);
        assert_eq!(line.column_at(15), 10);
    }

    #[test]
    fn inlays_at_the_end_of_a_line_do_not_move_its_last_cursor() {
        let line = DisplayLine::with_inlays("foo", &[hint(3, ": T"), hint(9, "!")]);
        assert_eq!(line.text, "foo: T!");
        assert_eq!(line.offset_of(3), 3);
        assert_eq!(line.column_at(7), 3);
        assert_eq!(line.range_end_offset(usize::MAX), 7);
        assert_eq!(line.range_end_offset(3), 7);
        assert_eq!(line.range_end_offset(2), 2);
    }

    #[test]
    fn several_inlays_at_one_column_go_in_order_and_tabs_count_them() {
        let line = DisplayLine::with_inlays("a\tb", &[hint(1, "xy"), hint(1, "z")]);
        assert_eq!(line.text, "axyz    b");
        assert_eq!(line.offset_of(2), 8);
        assert_eq!(line.column_at(8), 2);
    }

    #[test]
    fn a_line_without_inlays_is_laid_out_as_before() {
        let plain = DisplayLine::new("\tx");
        let empty = DisplayLine::with_inlays("\tx", &[]);
        assert_eq!(plain.text, empty.text);
        assert!(plain.inlay_ranges().is_empty());
        assert_eq!(plain.range_start_offset(1), plain.offset_of(1));
    }

    fn map(blocks: &[(usize, usize)]) -> BlockMap {
        let slots: Vec<BlockSlot> =
            blocks.iter().map(|(slot, height)| BlockSlot { slot: *slot, height: *height }).collect();
        BlockMap::new(&slots)
    }

    #[test]
    fn without_blocks_display_rows_are_buffer_rows() {
        let blocks = map(&[]);
        assert_eq!(blocks.display_row_of(7), 7);
        assert_eq!(blocks.row_at(7), DisplayRow::Text(7));
        assert_eq!(blocks.total_rows(10), 10);
    }

    #[test]
    fn blocks_add_rows_between_lines() {
        // A two-row block before line 2, and a one-row block before line 5.
        let blocks = map(&[(2, 2), (5, 1)]);
        assert_eq!(blocks.display_row_of(0), 0);
        assert_eq!(blocks.display_row_of(1), 1);
        assert_eq!(blocks.display_row_of(2), 4);
        assert_eq!(blocks.display_row_of(4), 6);
        assert_eq!(blocks.display_row_of(5), 8);
        assert_eq!(blocks.total_rows(6), 9);
        let drawn: Vec<DisplayRow> = (0..9).map(|row| blocks.row_at(row)).collect();
        assert_eq!(
            drawn,
            vec![
                DisplayRow::Text(0),
                DisplayRow::Text(1),
                DisplayRow::Block { block: 0, line: 0 },
                DisplayRow::Block { block: 0, line: 1 },
                DisplayRow::Text(2),
                DisplayRow::Text(3),
                DisplayRow::Text(4),
                DisplayRow::Block { block: 1, line: 0 },
                DisplayRow::Text(5),
            ]
        );
    }

    #[test]
    fn rows_and_display_rows_map_back_and_forth() {
        let blocks = map(&[(0, 3), (2, 1), (2, 2), (7, 1)]);
        for row in 0..12 {
            assert_eq!(blocks.row_at(blocks.display_row_of(row)), DisplayRow::Text(row));
        }
    }

    #[test]
    fn blocks_at_one_place_stack_and_empty_ones_keep_their_index() {
        let blocks = map(&[(1, 1), (1, 0), (1, 2)]);
        assert_eq!(blocks.row_at(1), DisplayRow::Block { block: 0, line: 0 });
        assert_eq!(blocks.row_at(2), DisplayRow::Block { block: 2, line: 0 });
        assert_eq!(blocks.row_at(3), DisplayRow::Block { block: 2, line: 1 });
        assert_eq!(blocks.row_at(4), DisplayRow::Text(1));
    }

    #[test]
    fn a_block_knows_which_display_rows_are_its_own() {
        let blocks = map(&[(1, 2), (1, 0), (3, 1)]);
        assert_eq!(blocks.rows_of(0), Some(1..3));
        assert_eq!(blocks.rows_of(1), None);
        assert_eq!(blocks.rows_of(2), Some(5..6));
    }

    #[test]
    fn a_block_after_the_last_line_adds_rows_at_the_end() {
        let blocks = map(&[(3, 2)]);
        assert_eq!(blocks.total_rows(3), 5);
        assert_eq!(blocks.row_at(3), DisplayRow::Block { block: 0, line: 0 });
        assert_eq!(blocks.display_row_of(2), 2);
    }
}
