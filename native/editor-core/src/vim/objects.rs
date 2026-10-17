//! Text objects: the word, quoted string, bracketed block or paragraph around the cursor, as
//! the range `diw`, `ci"`, `da(` and `yip` act on.

use ropey::Rope;

use crate::buffer::{Buffer, Position};
use crate::vim::motion::is_word_character;
use crate::vim::types::TextObject;

/// What a text object covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectRange {
    /// The characters from `start` up to, not including, `end`, as offsets in the text.
    Chars { start: usize, end: usize },
    /// Whole lines, from `first` to `last` counted from zero.
    Lines { first: usize, last: usize },
}

/// The range of an object at a position, `inner` or `around`, with a count, or none when the
/// cursor is not in one.
pub fn find_object(
    buffer: &Buffer,
    at: Position,
    object: TextObject,
    around: bool,
    count: usize,
) -> Option<ObjectRange> {
    let count = count.max(1);
    match object {
        TextObject::Word { big } => word_object(buffer, at, big, around, count),
        TextObject::Paragraph => paragraph_object(buffer, at.row, around, count),
        TextObject::Quote { quote } => quote_object(buffer, at, quote, around),
        TextObject::Pair { open, close } => pair_object(buffer, at, open, close, around),
        TextObject::Tag => tag_object(buffer, at, around, count),
        TextObject::Sentence => sentence_object(buffer, at, around, count),
    }
}

/// A stretch of one line that is all white space, all word characters or all punctuation.
struct Run {
    start: usize,
    end: usize,
    blank: bool,
}

/// The runs a line is made of.
fn runs_of(line: &str, big: bool) -> Vec<Run> {
    let class = |character: char| -> u8 {
        if character.is_whitespace() {
            0
        } else if big || is_word_character(character) {
            1
        } else {
            2
        }
    };
    let characters: Vec<char> = line.chars().collect();
    let mut runs: Vec<Run> = Vec::new();
    let mut start = 0;
    while start < characters.len() {
        let run_class = class(characters[start]);
        let mut end = start;
        while end < characters.len() && class(characters[end]) == run_class {
            end += 1;
        }
        runs.push(Run { start, end, blank: run_class == 0 });
        start = end;
    }
    runs
}

/// `iw`, `aw`, `iW` and `aW`.
fn word_object(buffer: &Buffer, at: Position, big: bool, around: bool, count: usize) -> Option<ObjectRange> {
    let line_start = buffer.offset_of(Position { row: at.row, column: 0 });
    let runs = runs_of(&buffer.line(at.row), big);
    if runs.is_empty() {
        return Some(ObjectRange::Chars { start: line_start, end: line_start });
    }
    let column = at.column.min(runs.last().map_or(0, |run| run.end.saturating_sub(1)));
    let first = runs.iter().position(|run| run.start <= column && column < run.end)?;
    let (start_column, end_column) = if around {
        around_word_columns(&runs, first, count)
    } else {
        let last = (first + count - 1).min(runs.len() - 1);
        (runs[first].start, runs[last].end)
    };
    Some(ObjectRange::Chars { start: line_start + start_column, end: line_start + end_column })
}

/// The columns `aw` covers: each word with the white space after it, or before the first word
/// when the line ends without any. From white space, the white space and the word after it.
fn around_word_columns(runs: &[Run], first: usize, count: usize) -> (usize, usize) {
    let mut index = first;
    let mut start = runs[first].start;
    let mut end = runs[first].end;
    let mut has_trailing_space = true;
    for step in 0..count {
        if step > 0 {
            index += 1;
        }
        let Some(run) = runs.get(index) else {
            break;
        };
        end = run.end;
        let next = runs.get(index + 1);
        if run.blank {
            if let Some(word) = next {
                end = word.end;
                index += 1;
            }
            has_trailing_space = true;
            continue;
        }
        has_trailing_space = false;
        if let Some(space) = next.filter(|next| next.blank) {
            end = space.end;
            index += 1;
            has_trailing_space = true;
        }
    }
    let starts_on_word = !runs[first].blank;
    if !has_trailing_space && starts_on_word && first > 0 && runs[first - 1].blank {
        start = runs[first - 1].start;
    }
    (start, end)
}

/// `i"`, `a"` and the other quotes: the pair on the cursor's line that holds the cursor, or
/// the first one after it.
fn quote_object(buffer: &Buffer, at: Position, quote: char, around: bool) -> Option<ObjectRange> {
    let line = buffer.line(at.row);
    let characters: Vec<char> = line.chars().collect();
    let mut quotes: Vec<usize> = Vec::new();
    for (index, character) in characters.iter().enumerate() {
        let escaped = index > 0 && characters[index - 1] == '\\';
        if *character == quote && !escaped {
            quotes.push(index);
        }
    }
    let pairs: Vec<(usize, usize)> = quotes.chunks_exact(2).map(|pair| (pair[0], pair[1])).collect();
    let holds_cursor = |pair: &&(usize, usize)| pair.0 <= at.column && at.column <= pair.1;
    let after_cursor = |pair: &&(usize, usize)| pair.0 > at.column;
    let (open, close) = pairs.iter().find(holds_cursor).or_else(|| pairs.iter().find(after_cursor)).copied()?;
    let line_start = buffer.offset_of(Position { row: at.row, column: 0 });
    if !around {
        return Some(ObjectRange::Chars { start: line_start + open + 1, end: line_start + close });
    }
    let mut start = open;
    let mut end = close + 1;
    let trailing = characters[end..].iter().take_while(|character| character.is_whitespace()).count();
    if trailing > 0 {
        end += trailing;
    } else {
        let leading = characters[..start].iter().rev().take_while(|character| character.is_whitespace()).count();
        start -= leading;
    }
    Some(ObjectRange::Chars { start: line_start + start, end: line_start + end })
}

/// The offset of the opening bracket of the block a position is in, when it is at `offset`.
fn opening_bracket(text: &Rope, offset: usize, open: char, close: char) -> Option<usize> {
    let character = text.get_char(offset)?;
    if character == open {
        return Some(offset);
    }
    let mut depth = 0usize;
    let mut cursor = offset;
    while cursor > 0 {
        cursor -= 1;
        let candidate = text.get_char(cursor)?;
        if candidate == close {
            depth += 1;
        } else if candidate == open {
            if depth == 0 {
                return Some(cursor);
            }
            depth -= 1;
        }
    }
    None
}

/// The offset of the bracket that closes the one at `open_offset`.
fn closing_bracket(text: &Rope, open_offset: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut cursor = open_offset + 1;
    while let Some(candidate) = text.get_char(cursor) {
        if candidate == open {
            depth += 1;
        } else if candidate == close {
            if depth == 0 {
                return Some(cursor);
            }
            depth -= 1;
        }
        cursor += 1;
    }
    None
}

/// `i(`, `a{` and the other bracket blocks. A block whose brackets sit on lines of their own
/// is taken as the lines between them.
fn pair_object(buffer: &Buffer, at: Position, open: char, close: char, around: bool) -> Option<ObjectRange> {
    let text = buffer.rope();
    let offset = buffer.offset_of(at);
    let open_offset = opening_bracket(text, offset, open, close)?;
    let close_offset = closing_bracket(text, open_offset, open, close)?;
    if around {
        return Some(ObjectRange::Chars { start: open_offset, end: close_offset + 1 });
    }
    let open_position = buffer.position_of(open_offset);
    let close_position = buffer.position_of(close_offset);
    let open_ends_line = text.get_char(open_offset + 1) == Some('\n');
    let close_line_prefix = buffer.line(close_position.row).chars().take(close_position.column).collect::<String>();
    let close_starts_line = close_line_prefix.trim().is_empty();
    let spans_lines = close_position.row > open_position.row;
    if open_ends_line && close_starts_line && spans_lines {
        if close_position.row == open_position.row + 1 {
            return Some(ObjectRange::Chars { start: open_offset + 1, end: open_offset + 1 });
        }
        return Some(ObjectRange::Lines { first: open_position.row + 1, last: close_position.row - 1 });
    }
    Some(ObjectRange::Chars { start: open_offset + 1, end: close_offset })
}

/// A start tag or an end tag found in the text: its name, and where it starts and ends as offsets.
struct Tag {
    name: String,
    closing: bool,
    start: usize,
    end: usize,
}

/// Tags that never have an end tag.
const VOID_TAGS: [&str; 14] =
    ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];

/// The start and end tags of `characters`, leaving out comments, self-closing tags and void tags.
fn tags_of(characters: &[char]) -> Vec<Tag> {
    let mut tags = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] != '<' {
            index += 1;
            continue;
        }
        let rest: String = characters[index..].iter().take(4).collect();
        if rest == "<!--" {
            let comment_end = (index + 4..characters.len().saturating_sub(2))
                .find(|at| characters[*at] == '-' && characters[*at + 1] == '-' && characters[*at + 2] == '>');
            index = comment_end.map_or(characters.len(), |at| at + 3);
            continue;
        }
        let Some(close) = characters[index..].iter().position(|character| *character == '>') else {
            break;
        };
        let end = index + close + 1;
        let inside: String = characters[index + 1..end - 1].iter().collect();
        let closing = inside.starts_with('/');
        let name: String = inside
            .trim_start_matches('/')
            .chars()
            .take_while(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | ':' | '.'))
            .collect();
        let self_closing = inside.ends_with('/');
        let void = VOID_TAGS.contains(&name.to_ascii_lowercase().as_str());
        if !name.is_empty() && !self_closing && !void {
            tags.push(Tag { name, closing, start: index, end });
        }
        index = end;
    }
    tags
}

/// `it` and `at`: the element around the cursor, `count` elements out. `it` is what is between
/// its tags and `at` includes them.
fn tag_object(buffer: &Buffer, at: Position, around: bool, count: usize) -> Option<ObjectRange> {
    let characters: Vec<char> = buffer.slice(0..buffer.length()).chars().collect();
    let offset = buffer.offset_of(at);
    let mut open_tags: Vec<&Tag> = Vec::new();
    let mut elements: Vec<(&Tag, &Tag)> = Vec::new();
    let tags = tags_of(&characters);
    for tag in &tags {
        if !tag.closing {
            open_tags.push(tag);
            continue;
        }
        let Some(matching) = open_tags.iter().rposition(|open| open.name == tag.name) else {
            continue;
        };
        let open = open_tags[matching];
        open_tags.truncate(matching);
        elements.push((open, tag));
    }
    let mut around_cursor: Vec<(&Tag, &Tag)> =
        elements.into_iter().filter(|(open, close)| open.start <= offset && offset < close.end).collect();
    around_cursor.sort_by_key(|(open, close)| close.end - open.start);
    let (open, close) = *around_cursor.get(count.max(1) - 1)?;
    if around {
        return Some(ObjectRange::Chars { start: open.start, end: close.end });
    }
    Some(ObjectRange::Chars { start: open.end, end: close.start })
}

/// Whether a character ends a sentence when white space follows it.
fn ends_sentence(character: char) -> bool {
    matches!(character, '.' | '!' | '?')
}

/// The sentences of a stretch of text, as the ranges of characters, each without the white space after it.
/// A sentence ends at `.`, `!` or `?` and any closing quotes or brackets after it, when white space
/// or the end of the text follows, and at a blank line.
fn sentences_of(characters: &[char]) -> Vec<(usize, usize)> {
    let mut sentences = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        while index < characters.len() && characters[index].is_whitespace() {
            index += 1;
        }
        if index >= characters.len() {
            break;
        }
        let start = index;
        let mut end = index;
        while end < characters.len() {
            let blank_line = characters[end] == '\n'
                && characters[end + 1..].iter().take_while(|next| **next != '\n').all(|next| next.is_whitespace())
                && end + 1 < characters.len()
                && characters[end + 1..].contains(&'\n');
            if blank_line {
                break;
            }
            if ends_sentence(characters[end]) {
                let mut stop = end + 1;
                while stop < characters.len() && matches!(characters[stop], ')' | ']' | '"' | '\'' | '}') {
                    stop += 1;
                }
                if stop >= characters.len() || characters[stop].is_whitespace() {
                    end = stop;
                    break;
                }
            }
            end += 1;
        }
        let mut trimmed = end;
        while trimmed > start && characters[trimmed - 1].is_whitespace() {
            trimmed -= 1;
        }
        sentences.push((start, trimmed));
        index = end;
    }
    sentences
}

/// `is` and `as`: the sentence at the cursor, with the white space after it for `as`. On white
/// space between sentences, `is` is the white space and `as` the white space and the next sentence.
fn sentence_object(buffer: &Buffer, at: Position, around: bool, count: usize) -> Option<ObjectRange> {
    let characters: Vec<char> = buffer.slice(0..buffer.length()).chars().collect();
    let offset = buffer.offset_of(at).min(characters.len().saturating_sub(1));
    let sentences = sentences_of(&characters);
    let count = count.max(1);
    let on_sentence = sentences.iter().position(|(start, end)| *start <= offset && offset < *end);
    let Some(first) = on_sentence else {
        let next = sentences.iter().position(|(start, _)| *start > offset)?;
        let gap_start = if next == 0 { 0 } else { sentences[next - 1].1 };
        if !around {
            return Some(ObjectRange::Chars { start: gap_start, end: sentences[next].0 });
        }
        let last = (next + count - 1).min(sentences.len() - 1);
        return Some(ObjectRange::Chars { start: gap_start, end: sentences[last].1 });
    };
    let last = (first + count - 1).min(sentences.len() - 1);
    let (start, end) = (sentences[first].0, sentences[last].1);
    if !around {
        return Some(ObjectRange::Chars { start, end });
    }
    let after = characters[end..].iter().take_while(|character| character.is_whitespace() && **character != '\n').count();
    if after > 0 {
        return Some(ObjectRange::Chars { start, end: end + after });
    }
    let before = characters[..start].iter().rev().take_while(|character| character.is_whitespace() && **character != '\n').count();
    Some(ObjectRange::Chars { start: start - before, end })
}

/// Whether a line separates paragraphs.
fn is_blank_line(buffer: &Buffer, row: usize) -> bool {
    buffer.line(row).trim().is_empty()
}

/// The last row of the run of lines from `row` that are all blank or all not blank.
fn run_end(buffer: &Buffer, row: usize) -> usize {
    let blank = is_blank_line(buffer, row);
    let last_row = buffer.line_count().saturating_sub(1);
    let mut end = row;
    while end < last_row && is_blank_line(buffer, end + 1) == blank {
        end += 1;
    }
    end
}

/// The first row of the run of lines that holds `row`.
fn run_start(buffer: &Buffer, row: usize) -> usize {
    let blank = is_blank_line(buffer, row);
    let mut start = row;
    while start > 0 && is_blank_line(buffer, start - 1) == blank {
        start -= 1;
    }
    start
}

/// `ip` and `ap`.
fn paragraph_object(buffer: &Buffer, row: usize, around: bool, count: usize) -> Option<ObjectRange> {
    let last_row = buffer.line_count().saturating_sub(1);
    let mut first = run_start(buffer, row);
    let mut last = run_end(buffer, row);
    let starts_blank = is_blank_line(buffer, row);
    let runs = if around { count * 2 } else { count };
    for _ in 1..runs {
        if last >= last_row {
            break;
        }
        last = run_end(buffer, last + 1);
    }
    if around && count == 1 && last >= last_row && !starts_blank && first > 0 {
        first = run_start(buffer, first - 1);
    }
    Some(ObjectRange::Lines { first, last })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn covered(text: &str, at: Position, object: TextObject, around: bool) -> Option<String> {
        let buffer = Buffer::from_text(text);
        match find_object(&buffer, at, object, around, 1)? {
            ObjectRange::Chars { start, end } => Some(buffer.slice(start..end)),
            ObjectRange::Lines { first, last } => {
                let lines: Vec<String> = (first..=last).map(|row| buffer.line(row)).collect();
                Some(format!("lines:{}", lines.join("|")))
            }
        }
    }

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    const WORD: TextObject = TextObject::Word { big: false };

    #[test]
    fn inner_and_around_word() {
        assert_eq!(covered("foo bar baz", at(0, 5), WORD, false).as_deref(), Some("bar"));
        assert_eq!(covered("foo bar baz", at(0, 5), WORD, true).as_deref(), Some("bar "));
        assert_eq!(covered("foo bar", at(0, 5), WORD, true).as_deref(), Some(" bar"));
        assert_eq!(covered("foo  bar", at(0, 3), WORD, false).as_deref(), Some("  "));
        assert_eq!(covered("foo  bar", at(0, 3), WORD, true).as_deref(), Some("  bar"));
        assert_eq!(covered("a.b", at(0, 1), WORD, false).as_deref(), Some("."));
    }

    #[test]
    fn quotes_hold_the_cursor_or_come_after_it() {
        let quote = TextObject::Quote { quote: '"' };
        let text = r#"say "hi there" now"#;
        assert_eq!(covered(text, at(0, 8), quote, false).as_deref(), Some("hi there"));
        assert_eq!(covered(text, at(0, 8), quote, true).as_deref(), Some("\"hi there\" "));
        assert_eq!(covered(text, at(0, 0), quote, false).as_deref(), Some("hi there"));
        assert_eq!(covered("no quotes", at(0, 0), quote, false), None);
    }

    #[test]
    fn brackets_nest_and_cross_lines() {
        let paren = TextObject::Pair { open: '(', close: ')' };
        assert_eq!(covered("f(a, (b), c)", at(0, 7), paren, false).as_deref(), Some("b"));
        assert_eq!(covered("f(a, (b), c)", at(0, 3), paren, false).as_deref(), Some("a, (b), c"));
        assert_eq!(covered("f(a, (b), c)", at(0, 3), paren, true).as_deref(), Some("(a, (b), c)"));
        let brace = TextObject::Pair { open: '{', close: '}' };
        assert_eq!(covered("{\n  a\n  b\n}", at(1, 2), brace, false).as_deref(), Some("lines:  a|  b"));
        assert_eq!(covered("x = { a }", at(0, 6), brace, false).as_deref(), Some(" a "));
    }

    #[test]
    fn paragraphs_are_runs_of_lines() {
        assert_eq!(covered("a\nb\n\nc", at(0, 0), TextObject::Paragraph, false).as_deref(), Some("lines:a|b"));
        assert_eq!(covered("a\nb\n\nc", at(1, 0), TextObject::Paragraph, true).as_deref(), Some("lines:a|b|"));
        assert_eq!(covered("a\n\nc\nd", at(2, 0), TextObject::Paragraph, true).as_deref(), Some("lines:|c|d"));
    }

    #[test]
    fn tags_are_the_element_around_the_cursor() {
        let text = "<div><p>hello <b>big</b> world</p></div>";
        assert_eq!(covered(text, at(0, 10), TextObject::Tag, false).as_deref(), Some("hello <b>big</b> world"));
        assert_eq!(covered(text, at(0, 10), TextObject::Tag, true).as_deref(), Some("<p>hello <b>big</b> world</p>"));
        assert_eq!(covered(text, at(0, 18), TextObject::Tag, false).as_deref(), Some("big"));
        assert_eq!(covered(text, at(0, 18), TextObject::Tag, true).as_deref(), Some("<b>big</b>"));
        assert_eq!(covered("<a><br>x</a>", at(0, 7), TextObject::Tag, false).as_deref(), Some("<br>x"));
        assert_eq!(covered("no tags", at(0, 2), TextObject::Tag, false), None);
        let buffer = Buffer::from_text(text);
        let outer = find_object(&buffer, at(0, 18), TextObject::Tag, false, 3).unwrap();
        assert_eq!(outer, ObjectRange::Chars { start: 5, end: 34 });
    }

    #[test]
    fn sentences_end_at_punctuation_followed_by_space() {
        let text = "One two. Three four! Five?";
        assert_eq!(covered(text, at(0, 2), TextObject::Sentence, false).as_deref(), Some("One two."));
        assert_eq!(covered(text, at(0, 12), TextObject::Sentence, false).as_deref(), Some("Three four!"));
        assert_eq!(covered(text, at(0, 12), TextObject::Sentence, true).as_deref(), Some("Three four! "));
        assert_eq!(covered(text, at(0, 22), TextObject::Sentence, true).as_deref(), Some(" Five?"));
        assert_eq!(covered("v1.2 is out. Yes.", at(0, 1), TextObject::Sentence, false).as_deref(), Some("v1.2 is out."));
        assert_eq!(covered("a. b", at(0, 3), TextObject::Sentence, false).as_deref(), Some("b"));
        assert_eq!(covered("a. b", at(0, 2), TextObject::Sentence, false).as_deref(), Some(" "));
        assert_eq!(covered("a. b", at(0, 2), TextObject::Sentence, true).as_deref(), Some(" b"));
        assert_eq!(covered("First.\n\nSecond one.", at(0, 1), TextObject::Sentence, false).as_deref(), Some("First."));
        assert_eq!(covered("Wraps over\ntwo lines. Next.", at(1, 1), TextObject::Sentence, false).as_deref(), Some("Wraps over\ntwo lines."));
    }
}
