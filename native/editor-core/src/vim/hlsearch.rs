//! Showing where the last search matches (vim's `hlsearch`) as decorations of the rows in view,
//! until `:noh` turns them off. Only matches inside one line are marked.

use std::ops::Range;

use crate::buffer::{Buffer, Position};
use crate::decorations::{Decoration, DecorationKind, Tone};
use crate::vim::pattern::Pattern;
use crate::vim::registers::VimMemory;

/// The decoration source the search marks are kept under.
pub const SEARCH_SOURCE: &str = "vim.search";

/// The most matches marked at once, so a pattern that matches everywhere does not fill the frame.
const MAX_MARKS: usize = 1000;

/// Lines longer than this are not searched, which keeps minified files from stalling a frame.
const MAX_LINE_CHARACTERS: usize = 2000;

/// The marks for the matches of the last search in `rows`, none while the highlight is off.
pub fn search_decorations(buffer: &Buffer, memory: &VimMemory, rows: Range<usize>) -> Vec<Decoration> {
    let Some(last) = memory.last_search.as_ref().filter(|_| memory.search_highlight) else {
        return Vec::new();
    };
    let Ok(pattern) = Pattern::parse(&last.pattern, last.whole_word, false) else {
        return Vec::new();
    };
    let mut marks = Vec::new();
    for row in rows.start..rows.end.min(buffer.line_count()) {
        let line = buffer.line(row);
        if line.len() > MAX_LINE_CHARACTERS {
            continue;
        }
        for found in pattern.regex().find_iter(&line) {
            if found.is_empty() {
                continue;
            }
            let column = line[..found.start()].chars().count();
            let length = found.as_str().chars().count();
            marks.push(Decoration {
                start: Position { row, column },
                end: Some(Position { row, column: column + length }),
                tooltip: None,
                kind: DecorationKind::Highlight { background: Some(Tone::SearchMatch), underline: None },
            });
            if marks.len() >= MAX_MARKS {
                return marks;
            }
        }
    }
    marks
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vim::registers::LastSearch;

    fn memory(pattern: &str, on: bool) -> VimMemory {
        let mut memory = VimMemory::default();
        memory.last_search = Some(LastSearch { pattern: pattern.to_string(), forward: true, whole_word: false });
        memory.search_highlight = on;
        memory
    }

    #[test]
    fn matches_in_the_rows_are_marked_while_the_highlight_is_on() {
        let buffer = Buffer::from_text("foo bar foo\nxx\nfoo");
        let marks = search_decorations(&buffer, &memory("fo+", false), 0..3);
        assert!(marks.is_empty());
        let marks = search_decorations(&buffer, &memory("fo\\+", true), 0..3);
        let places: Vec<_> = marks.iter().map(|mark| (mark.start.row, mark.start.column)).collect();
        assert_eq!(places, vec![(0, 0), (0, 8), (2, 0)]);
        assert_eq!(marks[0].end, Some(Position { row: 0, column: 3 }));
        let marks = search_decorations(&buffer, &memory("fo\\+", true), 2..3);
        assert_eq!(marks.len(), 1);
    }

    #[test]
    fn a_broken_pattern_or_an_empty_match_marks_nothing() {
        let buffer = Buffer::from_text("abc");
        assert!(search_decorations(&buffer, &memory("\\(", true), 0..1).is_empty());
        assert!(search_decorations(&buffer, &memory("x*", true), 0..1).is_empty());
    }
}
