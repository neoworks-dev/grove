//! The small set of highlight ids that grammar capture names are sorted into, and the step that
//! turns overlapping captures into runs of text with one id each.
//!
//! A theme gives a colour to each name in [`HIGHLIGHT_NAMES`], so a new grammar needs no theme
//! work as long as its captures land on one of them.

use std::ops::Range;

/// Names a kind of highlighted text: an index into [`HIGHLIGHT_NAMES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HighlightId(pub u8);

impl HighlightId {
    /// The name a theme colours this id by.
    pub fn name(self) -> &'static str {
        HIGHLIGHT_NAMES[self.0 as usize]
    }
}

/// Every highlight a theme can colour. Capture names that are not in the list fall back to
/// the longest dotted prefix that is, so `keyword.return` is coloured as `keyword` unless the
/// theme has more to say about it.
pub const HIGHLIGHT_NAMES: &[&str] = &[
    "attribute",
    "boolean",
    "comment",
    "comment.doc",
    "constant",
    "constant.builtin",
    "constructor",
    "embedded",
    "emphasis",
    "emphasis.strong",
    "enum",
    "function",
    "function.builtin",
    "function.macro",
    "function.method",
    "keyword",
    "label",
    "link_text",
    "link_uri",
    "module",
    "number",
    "operator",
    "preproc",
    "property",
    "punctuation",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation.special",
    "string",
    "string.escape",
    "string.regex",
    "string.special",
    "tag",
    "text.literal",
    "title",
    "type",
    "type.builtin",
    "variable",
    "variable.builtin",
    "variable.parameter",
];

/// Capture names that older grammars use for something this list names differently.
const ALIASES: &[(&str, &str)] = &[
    ("comment.documentation", "comment.doc"),
    ("conditional", "keyword"),
    ("repeat", "keyword"),
    ("float", "number"),
    ("storageclass", "keyword"),
    ("include", "keyword"),
    ("exception", "keyword"),
    ("escape", "string.escape"),
    ("field", "property"),
    ("method", "function.method"),
    ("method.call", "function.method"),
    ("function.call", "function"),
    ("namespace", "module"),
    ("parameter", "variable.parameter"),
    ("text.title", "title"),
    ("markup.heading", "title"),
    ("text.uri", "link_uri"),
    ("text.reference", "link_text"),
    ("text.emphasis", "emphasis"),
    ("text.strong", "emphasis.strong"),
    ("type.qualifier", "keyword"),
    ("string.special.key", "property"),
    ("variable.member", "property"),
    ("string.special.symbol", "string.special"),
];

/// The highlight a grammar's capture name stands for, or none for captures that only steer the
/// query, such as `@none`, `@spell` and the `@_helper` captures of predicates.
pub fn highlight_for_capture(name: &str) -> Option<HighlightId> {
    if name.starts_with('_') {
        return None;
    }
    let mut candidate = name;
    loop {
        if let Some(index) = HIGHLIGHT_NAMES.iter().position(|known| *known == candidate) {
            return Some(HighlightId(index as u8));
        }
        if let Some((_, target)) = ALIASES.iter().find(|(alias, _)| *alias == candidate) {
            return highlight_for_capture(target);
        }
        let (shorter, _) = candidate.rsplit_once('.')?;
        candidate = shorter;
    }
}

/// A run of text drawn with one highlight, as columns within a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HighlightSpan {
    pub start_column: usize,
    pub end_column: usize,
    pub id: HighlightId,
}

/// Turns captures into runs that do not overlap. The captures come ordered by where they start,
/// and when one lies inside another, or two cover the same text, the one that comes later wins
/// over the part it covers, which is how a grammar's more specific patterns override its general ones.
/// A capture with no highlight clears what is under it, and is not part of the result.
pub fn flatten_captures(captures: &[(Range<usize>, Option<HighlightId>)]) -> Vec<(Range<usize>, HighlightId)> {
    let mut runs: Vec<(Range<usize>, HighlightId)> = Vec::new();
    // Captures that have started and not ended, the innermost last.
    let mut open: Vec<(usize, Option<HighlightId>)> = Vec::new();
    let mut position = 0;
    for (range, id) in captures {
        close_runs_before(&mut open, &mut runs, &mut position, range.start);
        if let Some((_, enclosing)) = open.last() {
            push_run(&mut runs, position..range.start, *enclosing);
        }
        position = position.max(range.start);
        open.push((range.end, *id));
    }
    close_runs_before(&mut open, &mut runs, &mut position, usize::MAX);
    runs
}

/// Ends the open captures that finish at or before `limit`, emitting the text they covered.
fn close_runs_before(
    open: &mut Vec<(usize, Option<HighlightId>)>,
    runs: &mut Vec<(Range<usize>, HighlightId)>,
    position: &mut usize,
    limit: usize,
) {
    while let Some((end, id)) = open.last().copied() {
        if end > limit {
            return;
        }
        push_run(runs, *position..end, id);
        *position = (*position).max(end);
        open.pop();
    }
}

/// Adds a run unless it is empty or has no highlight, joining it to the run before when they
/// touch and agree.
fn push_run(runs: &mut Vec<(Range<usize>, HighlightId)>, range: Range<usize>, id: Option<HighlightId>) {
    let Some(id) = id else {
        return;
    };
    if range.start >= range.end {
        return;
    }
    let joins_previous =
        runs.last().is_some_and(|(previous, previous_id)| previous.end == range.start && *previous_id == id);
    if joins_previous {
        if let Some((previous, _)) = runs.last_mut() {
            previous.end = range.end;
        }
        return;
    }
    runs.push((range, id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str) -> HighlightId {
        highlight_for_capture(name).unwrap()
    }

    #[test]
    fn names_fall_back_to_their_prefix_and_aliases() {
        assert_eq!(id("keyword.return").name(), "keyword");
        assert_eq!(id("function.method").name(), "function.method");
        assert_eq!(id("function.call").name(), "function");
        assert_eq!(id("text.title").name(), "title");
        assert_eq!(id("type.qualifier").name(), "keyword");
        assert!(highlight_for_capture("none").is_none());
        assert!(highlight_for_capture("_helper").is_none());
        assert!(highlight_for_capture("spell").is_none());
    }

    #[test]
    fn an_inner_capture_wins_over_the_part_it_covers() {
        let string = id("string");
        let escape = id("string.escape");
        let runs = flatten_captures(&[(0..10, Some(string)), (3..5, Some(escape))]);
        assert_eq!(runs, vec![(0..3, string), (3..5, escape), (5..10, string)]);
    }

    #[test]
    fn the_later_of_two_captures_on_the_same_text_wins() {
        let runs = flatten_captures(&[(2..6, Some(id("variable"))), (2..6, Some(id("function")))]);
        assert_eq!(runs, vec![(2..6, id("function"))]);
    }

    #[test]
    fn a_capture_without_a_highlight_clears_what_is_under_it() {
        let string = id("string");
        let runs = flatten_captures(&[(0..10, Some(string)), (2..8, None), (4..6, Some(id("keyword")))]);
        assert_eq!(runs, vec![(0..2, string), (4..6, id("keyword")), (8..10, string)]);
    }

    #[test]
    fn gaps_stay_unhighlighted() {
        let runs = flatten_captures(&[(0..2, Some(id("keyword"))), (5..7, Some(id("number")))]);
        assert_eq!(runs, vec![(0..2, id("keyword")), (5..7, id("number"))]);
    }
}
