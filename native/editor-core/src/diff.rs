//! Comparing two texts: which lines changed, which words inside them, and the decorations that
//! show the difference in an editor. The same hunks drive an inline view (one editor over the
//! new text, the removed lines as blocks between its rows) and a side-by-side view (an editor
//! per text, with filler rows so the lines of a hunk sit next to each other).
//!
//! Lines are counted from zero, and a hunk says "the old lines here became the new lines there":
//! `old_start..old_start + old_len` was replaced by `new_start..new_start + new_len`. A hunk with
//! no old lines is an insertion, and one with no new lines is a deletion.

use std::ops::Range;

use crate::buffer::Position;
use crate::decorations::{BlockEmphasis, Decoration, DecorationKind, Placement, Tone};

/// The most edits Myers' algorithm is run for. A comparison that needs more is reported as
/// one hunk replacing everything that is not common to both ends, which keeps the memory the
/// search needs bounded for texts that have nothing in common.
const MAX_EDIT_DISTANCE: usize = 2000;

/// A changed stretch of lines: the old lines that were replaced, and the new lines that took their place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
}

impl Hunk {
    /// The old lines.
    pub fn old_lines(&self) -> Range<usize> {
        self.old_start..self.old_start + self.old_len
    }

    /// The new lines.
    pub fn new_lines(&self) -> Range<usize> {
        self.new_start..self.new_start + self.new_len
    }

    /// Whether a row of the new text belongs to the hunk. A deletion has no row of its own, so
    /// it belongs to the row after it.
    pub fn covers_new_row(&self, row: usize) -> bool {
        if self.new_len == 0 {
            return row == self.new_start;
        }
        self.new_lines().contains(&row)
    }

    /// Whether a row of the old text belongs to the hunk, as `covers_new_row` does for the new.
    pub fn covers_old_row(&self, row: usize) -> bool {
        if self.old_len == 0 {
            return row == self.old_start;
        }
        self.old_lines().contains(&row)
    }
}

/// Which text an editor shows, and so what its decorations draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The new text alone: removed lines are blocks between its rows.
    Inline,
    /// The old text beside the new: the lines that went are marked, and fillers stand for added ones.
    Old,
    /// The new text beside the old: the lines that came are marked, and fillers stand for removed ones.
    New,
}

/// The lines of a text, without the empty one a final line break would leave. Line endings other
/// than `\n` are the caller's to normalise.
pub fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n').collect()
}

/// The hunks that turn the old lines into the new ones, in order.
pub fn hunks(old: &[&str], new: &[&str]) -> Vec<Hunk> {
    let prefix = common_prefix(old, new);
    let suffix = common_suffix(&old[prefix..], &new[prefix..]);
    let old_middle = &old[prefix..old.len() - suffix];
    let new_middle = &new[prefix..new.len() - suffix];
    let regions = match changed_regions(old_middle, new_middle) {
        Some(regions) => regions,
        None => vec![(0..old_middle.len(), 0..new_middle.len())],
    };
    regions
        .into_iter()
        .filter(|(old_range, new_range)| !old_range.is_empty() || !new_range.is_empty())
        .map(|(old_range, new_range)| Hunk {
            old_start: prefix + old_range.start,
            old_len: old_range.len(),
            new_start: prefix + new_range.start,
            new_len: new_range.len(),
        })
        .collect()
}

/// How many items two sequences share at their starts.
fn common_prefix<T: PartialEq>(first: &[T], second: &[T]) -> usize {
    first.iter().zip(second).take_while(|(left, right)| left == right).count()
}

/// How many items two sequences share at their ends.
fn common_suffix<T: PartialEq>(first: &[T], second: &[T]) -> usize {
    first.iter().rev().zip(second.iter().rev()).take_while(|(left, right)| left == right).count()
}

/// The stretches of two sequences that differ, as the range of each that sits between matches.
/// None when the sequences differ by more than `MAX_EDIT_DISTANCE` edits.
fn changed_regions<T: PartialEq>(old: &[T], new: &[T]) -> Option<Vec<(Range<usize>, Range<usize>)>> {
    let matches = matching_pairs(old, new)?;
    let mut regions = Vec::new();
    let (mut old_next, mut new_next) = (0, 0);
    for (old_index, new_index) in matches {
        if old_index > old_next || new_index > new_next {
            regions.push((old_next..old_index, new_next..new_index));
        }
        old_next = old_index + 1;
        new_next = new_index + 1;
    }
    if old_next < old.len() || new_next < new.len() {
        regions.push((old_next..old.len(), new_next..new.len()));
    }
    Some(regions)
}

/// The pairs of equal items a shortest edit script keeps, in order, found with Myers' O(ND)
/// algorithm. None when the script is longer than `MAX_EDIT_DISTANCE`.
fn matching_pairs<T: PartialEq>(old: &[T], new: &[T]) -> Option<Vec<(usize, usize)>> {
    let (old_len, new_len) = (old.len() as isize, new.len() as isize);
    let limit = (old.len() + new.len()).min(MAX_EDIT_DISTANCE) as isize;
    let offset = limit + 1;
    let mut furthest = vec![0isize; (2 * limit + 3) as usize];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    for distance in 0..=limit {
        trace.push(snapshot(&furthest, offset, distance));
        for diagonal in (-distance..=distance).step_by(2) {
            let down = diagonal == -distance
                || (diagonal != distance
                    && furthest[(offset + diagonal - 1) as usize] < furthest[(offset + diagonal + 1) as usize]);
            let mut x = if down {
                furthest[(offset + diagonal + 1) as usize]
            } else {
                furthest[(offset + diagonal - 1) as usize] + 1
            };
            let mut y = x - diagonal;
            while x < old_len && y < new_len && old[x as usize] == new[y as usize] {
                x += 1;
                y += 1;
            }
            furthest[(offset + diagonal) as usize] = x;
            if x >= old_len && y >= new_len {
                return Some(walk_back(&trace, old_len, new_len));
            }
        }
    }
    None
}

/// The furthest-reaching points of the diagonals that matter at the start of a round: those from
/// `-distance - 1` to `distance + 1`, which is all the walk back reads of it.
fn snapshot(furthest: &[isize], offset: isize, distance: isize) -> Vec<isize> {
    furthest[(offset - distance - 1) as usize..=(offset + distance + 1) as usize].to_vec()
}

/// The diagonal steps of the edit script that ended at the far corner, from the furthest-reaching
/// points recorded at the start of each round.
fn walk_back(trace: &[Vec<isize>], old_len: isize, new_len: isize) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let (mut x, mut y) = (old_len, new_len);
    for (distance, furthest) in trace.iter().enumerate().rev() {
        let distance = distance as isize;
        let diagonal = x - y;
        let reached = |diagonal: isize| furthest[(diagonal + distance + 1) as usize];
        let down = diagonal == -distance || (diagonal != distance && reached(diagonal - 1) < reached(diagonal + 1));
        let previous_diagonal = if down { diagonal + 1 } else { diagonal - 1 };
        let previous_x = reached(previous_diagonal);
        let previous_y = previous_x - previous_diagonal;
        let (after_x, after_y) = if distance == 0 { (0, 0) } else { edit_end(down, previous_x, previous_y) };
        while x > after_x && y > after_y {
            x -= 1;
            y -= 1;
            pairs.push((x as usize, y as usize));
        }
        x = previous_x;
        y = previous_y;
    }
    pairs.reverse();
    pairs
}

/// Where the single insertion or deletion of a round ends, which is where the diagonal run after it starts.
fn edit_end(down: bool, previous_x: isize, previous_y: isize) -> (isize, isize) {
    if down {
        return (previous_x, previous_y + 1);
    }
    (previous_x + 1, previous_y)
}

/// The columns of two lines that differ by word, as ranges of characters in each: the words that
/// are in only one of them. Lines that share little give none, since marking nearly all of
/// each says nothing the line colour does not.
pub fn word_changes(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let old_tokens = tokens(old);
    let new_tokens = tokens(new);
    let old_words: Vec<&str> = old_tokens.iter().map(|token| token.text).collect();
    let new_words: Vec<&str> = new_tokens.iter().map(|token| token.text).collect();
    let Some(regions) = changed_regions(&old_words, &new_words) else {
        return (Vec::new(), Vec::new());
    };
    let old_ranges = merged_columns(&old_tokens, regions.iter().map(|(old_range, _)| old_range.clone()));
    let new_ranges = merged_columns(&new_tokens, regions.iter().map(|(_, new_range)| new_range.clone()));
    if mostly_changed(&old_ranges, old) || mostly_changed(&new_ranges, new) {
        return (Vec::new(), Vec::new());
    }
    (old_ranges, new_ranges)
}

/// Whether the ranges cover most of a line, so marking them would mark the line.
fn mostly_changed(ranges: &[Range<usize>], line: &str) -> bool {
    let changed: usize = ranges.iter().map(|range| range.len()).sum();
    let total = line.chars().count();
    total > 0 && changed * 10 >= total * 7
}

/// A word, a run of white space or a single other character of a line, and where it starts.
struct Token<'a> {
    text: &'a str,
    /// The column of its first character.
    column: usize,
    /// The number of characters.
    length: usize,
}

/// What kind of run a character belongs to, so a token is a run of one kind.
fn character_class(character: char) -> u8 {
    if character.is_alphanumeric() || character == '_' {
        return 0;
    }
    if character.is_whitespace() {
        return 1;
    }
    2
}

/// A line cut into words, runs of white space and single punctuation characters.
fn tokens(line: &str) -> Vec<Token<'_>> {
    let mut tokens: Vec<Token> = Vec::new();
    let mut previous_class = u8::MAX;
    let mut column = 0;
    for (byte, character) in line.char_indices() {
        let class = character_class(character);
        let extends_previous = class == previous_class && class != 2;
        match tokens.last_mut() {
            Some(last) if extends_previous => {
                last.length += 1;
                last.text = &line[byte - last.text.len()..byte + character.len_utf8()];
            }
            _ => tokens.push(Token { text: &line[byte..byte + character.len_utf8()], column, length: 1 }),
        }
        previous_class = class;
        column += 1;
    }
    tokens
}

/// The character columns the token ranges cover, with ranges that touch joined.
fn merged_columns(tokens: &[Token], token_ranges: impl Iterator<Item = Range<usize>>) -> Vec<Range<usize>> {
    let mut columns: Vec<Range<usize>> = Vec::new();
    for token_range in token_ranges {
        let Some(first) = tokens.get(token_range.start) else {
            continue;
        };
        let Some(last) = tokens[token_range.start..token_range.end].last() else {
            continue;
        };
        let range = first.column..last.column + last.length;
        match columns.last_mut() {
            Some(previous) if previous.end == range.start => previous.end = range.end,
            _ => columns.push(range),
        }
    }
    columns
}

/// An old line and the new line it became, with the columns of each that differ by word.
struct LinePair {
    old_row: usize,
    new_row: usize,
    old_ranges: Vec<Range<usize>>,
    new_ranges: Vec<Range<usize>>,
}

/// The word-level changes of the lines a hunk pairs up, one pair per line while both sides have one.
fn paired_changes(hunk: &Hunk, old: &[&str], new: &[&str]) -> Vec<LinePair> {
    let pairs = hunk.old_len.min(hunk.new_len);
    (0..pairs)
        .map(|offset| {
            let old_row = hunk.old_start + offset;
            let new_row = hunk.new_start + offset;
            let (old_ranges, new_ranges) = word_changes(old[old_row], new[new_row]);
            LinePair { old_row, new_row, old_ranges, new_ranges }
        })
        .collect()
}

/// The decorations an editor showing one side of a comparison needs, and the hunks they were
/// made from. `old_text` and `new_text` are the two texts; `side` says which of them the editor
/// shows, and so which rows the decorations are on.
pub fn decorations(old_text: &str, new_text: &str, side: Side) -> (Vec<Decoration>, Vec<Hunk>) {
    let old = split_lines(old_text);
    let new = split_lines(new_text);
    let found = hunks(&old, &new);
    let shown_rows = match side {
        Side::Old => buffer_rows(old_text),
        Side::Inline | Side::New => buffer_rows(new_text),
    };
    let mut decorations = Vec::new();
    for hunk in &found {
        let changes = paired_changes(hunk, &old, &new);
        match side {
            Side::Inline => inline_hunk(&mut decorations, hunk, &old, &changes, shown_rows),
            Side::Old => old_hunk(&mut decorations, hunk, &changes, shown_rows),
            Side::New => new_hunk(&mut decorations, hunk, &changes, shown_rows),
        }
    }
    (decorations, found)
}

/// The decorations that preview one hunk in an editor over the new text: the old lines as a
/// block above its rows, and nothing else.
pub fn preview_decorations(old_text: &str, new_text: &str, row: usize) -> Option<(Vec<Decoration>, Hunk)> {
    let old = split_lines(old_text);
    let new = split_lines(new_text);
    let hunk = hunks(&old, &new).into_iter().find(|hunk| hunk.covers_new_row(row))?;
    let changes = paired_changes(&hunk, &old, &new);
    let mut decorations = Vec::new();
    removed_block(&mut decorations, &hunk, &old, &changes, buffer_rows(new_text));
    Some((decorations, hunk))
}

/// How many rows an editor has for a text: its lines, plus the empty one after a final line break.
fn buffer_rows(text: &str) -> usize {
    let lines = split_lines(text).len();
    if text.ends_with('\n') || lines == 0 {
        return lines + 1;
    }
    lines
}

/// A position at the start of a row.
fn row_start(row: usize) -> Position {
    Position { row, column: 0 }
}

/// A whole-line tint, a bar in the gutter, and the highlighted words, for rows of one hunk.
fn marked_rows(
    decorations: &mut Vec<Decoration>,
    rows: Range<usize>,
    tone: Tone,
    word_tone: Tone,
    words: impl Iterator<Item = (usize, Vec<Range<usize>>)>,
) {
    if !rows.is_empty() {
        let last = Position { row: rows.end - 1, column: 0 };
        decorations.push(Decoration {
            start: row_start(rows.start),
            end: Some(last),
            tooltip: None,
            kind: DecorationKind::Line { tone },
        });
        let bar = DecorationKind::Gutter { mark: crate::decorations::GutterMark::Bar, tone: Some(tone) };
        decorations.push(Decoration { start: row_start(rows.start), end: Some(last), tooltip: None, kind: bar });
    }
    for (row, ranges) in words {
        for range in ranges {
            let kind = DecorationKind::Highlight { background: Some(word_tone), underline: None };
            let start = Position { row, column: range.start };
            decorations.push(Decoration { start, end: Some(Position { row, column: range.end }), tooltip: None, kind });
        }
    }
}

/// The tone of the new lines of a hunk: added when nothing was there, else modified.
fn new_tone(hunk: &Hunk) -> Tone {
    if hunk.old_len == 0 { Tone::Added } else { Tone::Modified }
}

/// A block of `lines` before the row `slot`, or after the last row when the slot is past the end.
fn block_at(
    slot: usize,
    shown_rows: usize,
    lines: Vec<String>,
    tone: Tone,
    emphasis: Vec<BlockEmphasis>,
) -> Decoration {
    let (row, placement) =
        if slot < shown_rows { (slot, Placement::Above) } else { (shown_rows.saturating_sub(1), Placement::Below) };
    let kind = DecorationKind::Block { lines, placement, tone: Some(tone), emphasis, key: None };
    Decoration { start: row_start(row), end: None, tooltip: None, kind }
}

/// The notch that marks lines deleted before a row.
fn deletion_notch(decorations: &mut Vec<Decoration>, row: usize, shown_rows: usize) {
    let row = row.min(shown_rows.saturating_sub(1));
    let kind = DecorationKind::Gutter { mark: crate::decorations::GutterMark::Notch, tone: Some(Tone::Deleted) };
    decorations.push(Decoration { start: row_start(row), end: None, tooltip: None, kind });
}

/// The block that shows a hunk's old lines above its new ones.
fn removed_block(
    decorations: &mut Vec<Decoration>,
    hunk: &Hunk,
    old: &[&str],
    changes: &[LinePair],
    shown_rows: usize,
) {
    if hunk.old_len == 0 {
        return;
    }
    let lines: Vec<String> = old[hunk.old_lines()].iter().map(|line| line.to_string()).collect();
    let mut emphasis = Vec::new();
    for pair in changes {
        for range in &pair.old_ranges {
            emphasis.push(BlockEmphasis { line: pair.old_row - hunk.old_start, start: range.start, end: range.end });
        }
    }
    decorations.push(block_at(hunk.new_start, shown_rows, lines, Tone::Deleted, emphasis));
}

/// A hunk in an editor over the new text alone.
fn inline_hunk(decorations: &mut Vec<Decoration>, hunk: &Hunk, old: &[&str], changes: &[LinePair], shown_rows: usize) {
    removed_block(decorations, hunk, old, changes, shown_rows);
    let words = changes.iter().map(|pair| (pair.new_row, pair.new_ranges.clone()));
    marked_rows(decorations, hunk.new_lines(), new_tone(hunk), Tone::AddedWord, words);
    if hunk.new_len == 0 {
        deletion_notch(decorations, hunk.new_start, shown_rows);
    }
}

/// A hunk in the editor over the old text, beside the new.
fn old_hunk(decorations: &mut Vec<Decoration>, hunk: &Hunk, changes: &[LinePair], shown_rows: usize) {
    let words = changes.iter().map(|pair| (pair.old_row, pair.old_ranges.clone()));
    marked_rows(decorations, hunk.old_lines(), Tone::Deleted, Tone::DeletedWord, words);
    if hunk.new_len > hunk.old_len {
        let filler = vec![String::new(); hunk.new_len - hunk.old_len];
        decorations.push(block_at(hunk.old_start + hunk.old_len, shown_rows, filler, Tone::Filler, Vec::new()));
    }
}

/// A hunk in the editor over the new text, beside the old.
fn new_hunk(decorations: &mut Vec<Decoration>, hunk: &Hunk, changes: &[LinePair], shown_rows: usize) {
    let words = changes.iter().map(|pair| (pair.new_row, pair.new_ranges.clone()));
    marked_rows(decorations, hunk.new_lines(), new_tone(hunk), Tone::AddedWord, words);
    if hunk.old_len > hunk.new_len {
        let filler = vec![String::new(); hunk.old_len - hunk.new_len];
        decorations.push(block_at(hunk.new_start + hunk.new_len, shown_rows, filler, Tone::Filler, Vec::new()));
    }
}

/// A patch that applies one hunk to the old text, for `git apply --unidiff-zero`. Paths are
/// relative to the repository's root.
pub fn hunk_patch(path: &str, old_text: &str, new_text: &str, hunk: &Hunk) -> String {
    let old = split_lines(old_text);
    let new = split_lines(new_text);
    let old_start = if hunk.old_len == 0 { hunk.old_start } else { hunk.old_start + 1 };
    let new_start = if hunk.new_len == 0 { hunk.new_start } else { hunk.new_start + 1 };
    let mut patch = format!("--- a/{path}\n+++ b/{path}\n");
    patch.push_str(&format!("@@ -{old_start},{} +{new_start},{} @@\n", hunk.old_len, hunk.new_len));
    let old_open_ended = !old_text.is_empty() && !old_text.ends_with('\n') && hunk.old_lines().end == old.len();
    let new_open_ended = !new_text.is_empty() && !new_text.ends_with('\n') && hunk.new_lines().end == new.len();
    push_patch_lines(&mut patch, '-', &old[hunk.old_lines()], old_open_ended);
    push_patch_lines(&mut patch, '+', &new[hunk.new_lines()], new_open_ended);
    patch
}

/// Adds lines to a patch under a marker, noting that the last has no line break when `open_ended`.
fn push_patch_lines(patch: &mut String, marker: char, lines: &[&str], open_ended: bool) {
    for line in lines {
        patch.push(marker);
        patch.push_str(line);
        patch.push('\n');
    }
    if open_ended && !lines.is_empty() {
        patch.push_str("\\ No newline at end of file\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(old: &str, new: &str) -> Vec<Hunk> {
        hunks(&split_lines(old), &split_lines(new))
    }

    fn hunk(old_start: usize, old_len: usize, new_start: usize, new_len: usize) -> Hunk {
        Hunk { old_start, old_len, new_start, new_len }
    }

    #[test]
    fn equal_texts_have_no_hunks() {
        assert!(found("a\nb\n", "a\nb\n").is_empty());
        assert!(found("", "").is_empty());
    }

    #[test]
    fn a_changed_line_is_one_hunk_replacing_it() {
        assert_eq!(found("a\nb\nc\n", "a\nB\nc\n"), vec![hunk(1, 1, 1, 1)]);
    }

    #[test]
    fn insertions_and_deletions_have_one_empty_side() {
        assert_eq!(found("a\nc\n", "a\nb\nc\n"), vec![hunk(1, 0, 1, 1)]);
        assert_eq!(found("a\nb\nc\n", "a\nc\n"), vec![hunk(1, 1, 1, 0)]);
        assert_eq!(found("", "a\nb\n"), vec![hunk(0, 0, 0, 2)]);
        assert_eq!(found("a\nb\n", ""), vec![hunk(0, 2, 0, 0)]);
    }

    #[test]
    fn separate_changes_are_separate_hunks_with_the_lines_between_them_kept() {
        let old = "1\n2\n3\n4\n5\n6\n7\n";
        let new = "1\nx\n3\n4\n5\ny\nz\n7\n";
        assert_eq!(found(old, new), vec![hunk(1, 1, 1, 1), hunk(5, 1, 5, 2)]);
    }

    #[test]
    fn a_moved_block_is_a_deletion_and_an_insertion() {
        let hunks = found("a\nb\nc\nd\n", "c\nd\na\nb\n");
        let removed: usize = hunks.iter().map(|hunk| hunk.old_len).sum();
        let added: usize = hunks.iter().map(|hunk| hunk.new_len).sum();
        assert_eq!((removed, added), (2, 2));
    }

    #[test]
    fn a_text_with_nothing_in_common_is_one_hunk() {
        let old: Vec<String> = (0..3000).map(|number| format!("old {number}")).collect();
        let new: Vec<String> = (0..3000).map(|number| format!("new {number}")).collect();
        let old_lines: Vec<&str> = old.iter().map(String::as_str).collect();
        let new_lines: Vec<&str> = new.iter().map(String::as_str).collect();
        assert_eq!(hunks(&old_lines, &new_lines), vec![hunk(0, 3000, 0, 3000)]);
    }

    #[test]
    fn applying_the_hunks_to_the_old_lines_gives_the_new_ones() {
        let old = "a\nb\nc\nd\ne\nf\ng\n";
        let new = "a\nB\nc\nd\nnew\ne\ng\nh\n";
        let old_lines = split_lines(old);
        let new_lines = split_lines(new);
        let mut rebuilt: Vec<&str> = Vec::new();
        let mut next_old = 0;
        for hunk in hunks(&old_lines, &new_lines) {
            rebuilt.extend(&old_lines[next_old..hunk.old_start]);
            rebuilt.extend(&new_lines[hunk.new_lines()]);
            next_old = hunk.old_start + hunk.old_len;
        }
        rebuilt.extend(&old_lines[next_old..]);
        assert_eq!(rebuilt, new_lines);
    }

    #[test]
    fn a_deletion_belongs_to_the_row_after_it() {
        let deletion = hunk(1, 1, 1, 0);
        assert!(deletion.covers_new_row(1));
        assert!(!deletion.covers_new_row(0));
        let change = hunk(2, 2, 2, 3);
        assert!(change.covers_new_row(4) && !change.covers_new_row(5));
    }

    #[test]
    fn words_are_compared_not_characters() {
        let (old, new) = word_changes(
            "let greeting = format!(\"Hello, {}\", name);",
            "let greeting = format!(\"Hello there, {}!\", name);",
        );
        assert_eq!(old, Vec::<Range<usize>>::new());
        assert_eq!(new.len(), 2);
        assert_eq!(new[0], 29..35);
    }

    #[test]
    fn a_line_that_is_mostly_different_gets_no_word_marks() {
        let (old, new) = word_changes("alpha beta", "gamma delta");
        assert!(old.is_empty() && new.is_empty());
    }

    #[test]
    fn a_renamed_identifier_is_marked_in_both_lines() {
        let (old, new) =
            word_changes("fn compute_total(items: &[Item]) -> u32 {", "fn compute_sum(items: &[Item]) -> u32 {");
        assert_eq!(old, vec![3..16]);
        assert_eq!(new, vec![3..14]);
    }

    fn blocks_of(decorations: &[Decoration]) -> Vec<(usize, Placement, usize, Tone)> {
        decorations
            .iter()
            .filter_map(|decoration| match &decoration.kind {
                DecorationKind::Block { lines, placement, tone, .. } => {
                    Some((decoration.start.row, *placement, lines.len(), tone.unwrap()))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn inline_shows_removed_lines_as_a_block_above_the_new_ones() {
        let (decorations, found) = decorations("a\nb\nc\n", "a\nB\nB2\nc\n", Side::Inline);
        assert_eq!(found, vec![hunk(1, 1, 1, 2)]);
        assert_eq!(blocks_of(&decorations), vec![(1, Placement::Above, 1, Tone::Deleted)]);
        let tinted = decorations.iter().any(|decoration| {
            matches!(decoration.kind, DecorationKind::Line { tone: Tone::Modified }) && decoration.end.unwrap().row == 2
        });
        assert!(tinted);
    }

    #[test]
    fn a_deletion_at_the_end_puts_its_block_below_the_last_row() {
        let (decorations, _) = decorations("a\nb\nc", "a\nb", Side::Inline);
        assert_eq!(blocks_of(&decorations), vec![(1, Placement::Below, 1, Tone::Deleted)]);
    }

    #[test]
    fn the_sides_of_a_split_view_get_fillers_so_their_rows_line_up() {
        let old = "a\nb\nc\nd\n";
        let new = "a\nB1\nB2\nB3\nc\nd\n";
        let (old_side, _) = decorations(old, new, Side::Old);
        assert_eq!(blocks_of(&old_side), vec![(2, Placement::Above, 2, Tone::Filler)]);
        let (new_side, _) = decorations("a\nb1\nb2\nc\n", "a\nB\nc\n", Side::New);
        assert_eq!(blocks_of(&new_side), vec![(2, Placement::Above, 1, Tone::Filler)]);
    }

    #[test]
    fn both_sides_have_the_same_number_of_rows_through_every_hunk() {
        let old = "1\n2\n3\n4\n5\n6\n7\n8\n";
        let new = "1\nx\n3\n4\n5\n5b\n5c\n6\n8\n";
        let fillers = |side| {
            let (found, _) = decorations(old, new, side);
            blocks_of(&found).iter().map(|block| block.2).sum::<usize>()
        };
        let old_rows = buffer_rows(old) + fillers(Side::Old);
        let new_rows = buffer_rows(new) + fillers(Side::New);
        assert_eq!(old_rows, new_rows);
    }

    #[test]
    fn a_patch_for_a_hunk_names_the_lines_it_removes_and_adds() {
        let patch = hunk_patch("src/a.rs", "a\nb\nc\n", "a\nB\nc\n", &hunk(1, 1, 1, 1));
        assert_eq!(patch, "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -2,1 +2,1 @@\n-b\n+B\n");
    }

    #[test]
    fn a_patch_for_an_insertion_starts_after_the_line_it_follows() {
        let patch = hunk_patch("a", "a\nc\n", "a\nb\nc\n", &hunk(1, 0, 1, 1));
        assert_eq!(patch, "--- a/a\n+++ b/a\n@@ -1,0 +2,1 @@\n+b\n");
    }

    #[test]
    fn a_patch_marks_a_last_line_without_a_line_break() {
        let patch = hunk_patch("a", "a\nb", "a\nB", &hunk(1, 1, 1, 1));
        assert_eq!(
            patch,
            "--- a/a\n+++ b/a\n@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
        );
    }

    #[test]
    fn a_preview_is_the_old_lines_of_the_hunk_under_the_row() {
        let (decorations, found) = preview_decorations("a\nb\nc\n", "a\nB\nc\n", 1).unwrap();
        assert_eq!(found, hunk(1, 1, 1, 1));
        assert_eq!(blocks_of(&decorations), vec![(1, Placement::Above, 1, Tone::Deleted)]);
        assert!(preview_decorations("a\nb\nc\n", "a\nB\nc\n", 0).is_none());
    }
}
