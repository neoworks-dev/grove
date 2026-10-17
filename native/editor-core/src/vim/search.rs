//! Searching the text for a typed pattern. The pattern is plain text, matched exactly.

use crate::buffer::Buffer;
use crate::selections::Selection;
use crate::vim::motion::is_word_character;
use crate::vim::registers::{LastSearch, VimMemory};
use crate::vim::types::SearchRequest;

/// The offset of the match of `pattern` nearest to `from` in a direction, wrapping around the
/// text. A match that starts at `from` itself is not the nearest one, so searching again moves
/// on. With `whole_word`, a match only counts when no word character touches it.
pub fn find_match(buffer: &Buffer, pattern: &str, from: usize, forward: bool, whole_word: bool) -> Option<usize> {
    let needle: Vec<char> = pattern.chars().collect();
    if needle.is_empty() {
        return None;
    }
    let text: Vec<char> = buffer.slice(0..buffer.length()).chars().collect();
    if text.len() < needle.len() {
        return None;
    }
    let matches_at = |start: usize| {
        if text[start..start + needle.len()] != needle[..] {
            return false;
        }
        if !whole_word {
            return true;
        }
        let before_is_word = start > 0 && is_word_character(text[start - 1]);
        let after_is_word = text.get(start + needle.len()).is_some_and(|character| is_word_character(*character));
        !before_is_word && !after_is_word
    };
    let last_start = text.len() - needle.len();
    let starts: Vec<usize> = if forward {
        (from + 1..=last_start).chain(0..=from.min(last_start)).collect()
    } else {
        (0..from.min(last_start + 1)).rev().chain((from.min(last_start)..=last_start).rev()).collect()
    };
    starts.into_iter().find(|start| matches_at(*start))
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
    for _ in 0..count.max(1) {
        from = find_match(buffer, &search.pattern, from, search.forward, search.whole_word)?;
    }
    Some(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_search_skips_the_match_under_the_cursor_and_wraps() {
        let buffer = Buffer::from_text("foo bar foo baz foo");
        assert_eq!(find_match(&buffer, "foo", 0, true, false), Some(8));
        assert_eq!(find_match(&buffer, "foo", 16, true, false), Some(0));
        assert_eq!(find_match(&buffer, "zzz", 0, true, false), None);
    }

    #[test]
    fn backward_search_goes_to_the_one_before_and_wraps() {
        let buffer = Buffer::from_text("foo bar foo baz foo");
        assert_eq!(find_match(&buffer, "foo", 16, false, false), Some(8));
        assert_eq!(find_match(&buffer, "foo", 0, false, false), Some(16));
    }

    #[test]
    fn whole_word_matches_ignore_longer_words() {
        let buffer = Buffer::from_text("foobar foo");
        assert_eq!(find_match(&buffer, "foo", 0, true, true), Some(7));
        assert_eq!(find_match(&buffer, "foo", 0, true, false), Some(7));
        assert_eq!(find_match(&buffer, "foo", 7, true, true), Some(7));
    }
}
