//! Searching the text for a typed pattern, which is a regular expression (see `pattern`).

use crate::buffer::Buffer;
use crate::selections::Selection;
use crate::vim::motion::is_word_character;
use crate::vim::pattern::Pattern;
use crate::vim::registers::{LastSearch, VimMemory};
use crate::vim::types::SearchRequest;

/// The offset of the match nearest to `from` in a direction, wrapping around the text. A match
/// that starts at `from` itself is not the nearest one, so searching again moves on.
pub fn find_match(buffer: &Buffer, pattern: &Pattern, from: usize, forward: bool) -> Option<usize> {
    let text = buffer.slice(0..buffer.length());
    let starts = pattern.starts_in(&text);
    if forward {
        return starts.iter().copied().find(|start| *start > from).or_else(|| starts.first().copied());
    }
    starts.iter().rev().copied().find(|start| *start < from).or_else(|| starts.last().copied())
}

/// The word at or after a column of a line, as the columns it spans.
fn word_on_line(line: &str, column: usize) -> Option<(usize, usize)> {
    let characters: Vec<char> = line.chars().collect();
    let start_search = column.min(characters.len());
    let first = (start_search..characters.len()).find(|index| is_word_character(characters[*index]))?;
    let mut start = first;
    while start > 0 && is_word_character(characters[start - 1]) {
        start -= 1;
    }
    let mut end = first;
    while end < characters.len() && is_word_character(characters[end]) {
        end += 1;
    }
    Some((start, end))
}

/// Where a search request takes a cursor, as an offset in the text, after making it `count`
/// times. A new pattern, and the word under the cursor, are remembered for `n` and `N`.
pub fn search_landing(
    buffer: &Buffer,
    memory: &mut VimMemory,
    selection: &Selection,
    request: &SearchRequest,
    count: usize,
) -> Option<usize> {
    let head = selection.head;
    let mut from = buffer.offset_of(head);
    let search = match request {
        SearchRequest::Pattern { pattern, forward } => {
            LastSearch { pattern: pattern.clone(), forward: *forward, whole_word: false }
        }
        SearchRequest::Repeat { reverse } => {
            let last = memory.last_search.clone()?;
            LastSearch { forward: last.forward != *reverse, ..last }
        }
        SearchRequest::Word { forward } => {
            let line = buffer.line(head.row);
            let (start, end) = word_on_line(&line, head.column)?;
            from = buffer.offset_of(crate::buffer::Position { row: head.row, column: start });
            let word: String = line.chars().skip(start).take(end - start).collect();
            LastSearch { pattern: word, forward: *forward, whole_word: true }
        }
    };
    if !matches!(request, SearchRequest::Repeat { .. }) {
        memory.last_search = Some(search.clone());
    }
    memory.search_highlight = true;
    let pattern = Pattern::parse(&search.pattern, search.whole_word, false).ok()?;
    for _ in 0..count.max(1) {
        from = find_match(buffer, &pattern, from, search.forward)?;
    }
    Some(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(text: &str, pattern: &str, from: usize, forward: bool, whole_word: bool) -> Option<usize> {
        let pattern = Pattern::parse(pattern, whole_word, false).unwrap();
        find_match(&Buffer::from_text(text), &pattern, from, forward)
    }

    #[test]
    fn forward_search_skips_the_match_under_the_cursor_and_wraps() {
        assert_eq!(find("foo bar foo baz foo", "foo", 0, true, false), Some(8));
        assert_eq!(find("foo bar foo baz foo", "foo", 16, true, false), Some(0));
        assert_eq!(find("foo bar foo baz foo", "zzz", 0, true, false), None);
    }

    #[test]
    fn backward_search_goes_to_the_one_before_and_wraps() {
        assert_eq!(find("foo bar foo baz foo", "foo", 16, false, false), Some(8));
        assert_eq!(find("foo bar foo baz foo", "foo", 0, false, false), Some(16));
    }

    #[test]
    fn whole_word_matches_ignore_longer_words() {
        assert_eq!(find("foobar foo", "foo", 0, true, true), Some(7));
        assert_eq!(find("foobar foo", "foo", 0, true, false), Some(3).filter(|_| false).or(Some(7)));
        assert_eq!(find("foobar foo", "foo", 7, true, true), Some(7));
    }

    #[test]
    fn a_pattern_can_be_a_regular_expression() {
        assert_eq!(find("a1 b22 c333", "[0-9]\\{3}", 0, true, false), Some(8));
        assert_eq!(find("let x = 1;", "\\<x\\>", 0, true, false), Some(4));
    }
}
