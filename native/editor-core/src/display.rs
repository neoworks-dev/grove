//! How a buffer line is drawn: tabs become spaces up to the next tab stop, and each
//! character of the line keeps its place in the drawn text so the cursor and the pointer
//! can be mapped between the two.

/// Columns between tab stops.
pub const TAB_WIDTH: usize = 4;

pub struct DisplayLine {
    /// The text as it is shaped and painted.
    pub text: String,
    /// The byte offset in `text` where each character of the buffer line starts, with one
    /// more entry for the end of the line.
    offsets: Vec<usize>,
}

impl DisplayLine {
    /// Lays out one buffer line, without its line ending.
    pub fn new(line: &str) -> Self {
        let mut text = String::with_capacity(line.len());
        let mut offsets = Vec::with_capacity(line.len() + 1);
        let mut display_column = 0;
        for character in line.chars() {
            offsets.push(text.len());
            if character == '\t' {
                let spaces = TAB_WIDTH - display_column % TAB_WIDTH;
                text.extend(std::iter::repeat_n(' ', spaces));
                display_column += spaces;
            } else {
                text.push(character);
                display_column += 1;
            }
        }
        offsets.push(text.len());
        DisplayLine { text, offsets }
    }

    /// The byte offset in the drawn text where a buffer column starts. Columns past the
    /// end of the line land at its end.
    pub fn offset_of(&self, column: usize) -> usize {
        let last = self.offsets.len() - 1;
        self.offsets[column.min(last)]
    }

    /// The buffer column whose start is at or after a byte offset in the drawn text, so a
    /// point inside a tab lands after it.
    pub fn column_at(&self, offset: usize) -> usize {
        let column = self.offsets.partition_point(|start| *start < offset);
        column.min(self.offsets.len() - 1)
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
}
