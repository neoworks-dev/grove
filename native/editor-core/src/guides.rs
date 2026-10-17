//! Indent guides: how many guide lines each visible row has, and which of them belong to the
//! scope around the cursor, which is drawn brighter. Both come from the text's indentation, so
//! they work in every language. Blank lines carry the guides of the code around them, so a guide
//! runs unbroken through a gap inside a block.

use std::ops::Range;

use crate::buffer::Buffer;
use crate::indent::{IndentStyle, is_blank, leading_columns};

/// How many rows past the visible ones are read, so a blank line at the edge finds the lines
/// around it and a scope reaches a little past the edge.
const MARGIN_ROWS: usize = 60;

/// How far from the visible rows the cursor can be for its scope to be worked out, which keeps
/// the work of a frame small however far the cursor is left behind.
const MAX_CURSOR_DISTANCE: usize = 1500;

/// The scope around the cursor: the guide of one indentation level, along a run of rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scope {
    /// The first and last row of the scope, both included.
    pub first_row: usize,
    pub last_row: usize,
    /// Which guide it is, counted from the left margin, which is guide zero.
    pub level: usize,
}

/// The guides of a stretch of rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guides {
    /// The row `levels` starts at.
    first_row: usize,
    /// How many guides each row has, from `first_row` on.
    levels: Vec<usize>,
    scope: Option<Scope>,
}

impl Guides {
    /// The guides for `rows`, and the scope of the cursor on `cursor_row`, in a text indented in `style`.
    pub fn compute(buffer: &Buffer, rows: Range<usize>, cursor_row: usize, style: IndentStyle) -> Guides {
        let line_count = buffer.line_count();
        let mut first_row = rows.start.saturating_sub(MARGIN_ROWS);
        let mut end_row = (rows.end + MARGIN_ROWS).min(line_count);
        let distance = distance_between(&rows, cursor_row);
        if distance <= MAX_CURSOR_DISTANCE && cursor_row < line_count {
            first_row = first_row.min(cursor_row.saturating_sub(MARGIN_ROWS));
            end_row = end_row.max((cursor_row + MARGIN_ROWS).min(line_count));
        }
        let raw: Vec<Option<usize>> =
            (first_row..end_row).map(|row| raw_levels(&buffer.line(row), style.columns())).collect();
        let levels = fill_blank_rows(&raw);
        let scope = scope_around(&raw, &levels, first_row, cursor_row);
        Guides { first_row, levels, scope }
    }

    /// How many guides a row has, or none for a row that was not read.
    pub fn levels_of(&self, row: usize) -> usize {
        let Some(index) = row.checked_sub(self.first_row) else {
            return 0;
        };
        self.levels.get(index).copied().unwrap_or(0)
    }

    /// The scope around the cursor, if it has one.
    pub fn scope(&self) -> Option<Scope> {
        self.scope
    }

    /// Whether the guide at `level` on `row` is the one of the cursor's scope.
    pub fn is_active(&self, row: usize, level: usize) -> bool {
        match self.scope {
            Some(scope) => scope.level == level && (scope.first_row..=scope.last_row).contains(&row),
            None => false,
        }
    }
}

/// How far a row is from a range of rows, zero inside it.
fn distance_between(rows: &Range<usize>, row: usize) -> usize {
    if row < rows.start {
        return rows.start - row;
    }
    row.saturating_sub(rows.end)
}

/// How many indentation levels a line is indented by, or none for a line with nothing on it.
fn raw_levels(line: &str, columns_per_level: usize) -> Option<usize> {
    if is_blank(line) {
        return None;
    }
    Some(leading_columns(line) / columns_per_level)
}

/// The levels of every row, where a blank row has as many as the fewer of the rows above and
/// below it, so a guide only runs through a gap that both sides share.
fn fill_blank_rows(raw: &[Option<usize>]) -> Vec<usize> {
    let mut above: Vec<Option<usize>> = Vec::with_capacity(raw.len());
    let mut nearest = None;
    for level in raw {
        if level.is_some() {
            nearest = *level;
        }
        above.push(nearest);
    }
    let mut levels = vec![0; raw.len()];
    let mut below = None;
    for (index, level) in raw.iter().enumerate().rev() {
        if level.is_some() {
            below = *level;
        }
        levels[index] = match (level, above[index], below) {
            (Some(own), _, _) => *own,
            (None, Some(before), Some(after)) => before.min(after),
            (None, Some(only), None) | (None, None, Some(only)) => only,
            (None, None, None) => 0,
        };
    }
    levels
}

/// The scope of the cursor's row: the body of a block the row opens, or closes, or else the block
/// the row is in. None for a row at the margin that opens nothing, or when the row was not read.
fn scope_around(raw: &[Option<usize>], levels: &[usize], first_row: usize, cursor_row: usize) -> Option<Scope> {
    let cursor_index = cursor_row.checked_sub(first_row)?;
    if cursor_index >= levels.len() {
        return None;
    }
    let own = levels[cursor_index];
    if raw[cursor_index].is_some() {
        if let Some(body_start) = following_code_row(raw, cursor_index).filter(|index| levels[*index] > own) {
            return Some(run_around(levels, first_row, body_start, levels[body_start]));
        }
        if let Some(body_end) = preceding_code_row(raw, cursor_index).filter(|index| levels[*index] > own) {
            return Some(run_around(levels, first_row, body_end, levels[body_end]));
        }
    }
    if own == 0 {
        return None;
    }
    Some(run_around(levels, first_row, cursor_index, own))
}

/// The nearest row below `index` that has code on it.
fn following_code_row(raw: &[Option<usize>], index: usize) -> Option<usize> {
    (index + 1..raw.len()).find(|candidate| raw[*candidate].is_some())
}

/// The nearest row above `index` that has code on it.
fn preceding_code_row(raw: &[Option<usize>], index: usize) -> Option<usize> {
    (0..index).rev().find(|candidate| raw[*candidate].is_some())
}

/// The rows around `index` that have at least `level` guides, and the guide just left of their text.
fn run_around(levels: &[usize], first_row: usize, index: usize, level: usize) -> Scope {
    let mut first = index;
    while first > 0 && levels[first - 1] >= level {
        first -= 1;
    }
    let mut last = index;
    while last + 1 < levels.len() && levels[last + 1] >= level {
        last += 1;
    }
    Scope { first_row: first_row + first, last_row: first_row + last, level: level - 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: IndentStyle = IndentStyle::Spaces { width: 2 };

    fn guides_for(text: &str, cursor_row: usize) -> Guides {
        let buffer = Buffer::from_text(text);
        Guides::compute(&buffer, 0..buffer.line_count(), cursor_row, TWO)
    }

    const CODE: &str = "fn a() {\n  if b {\n    c;\n\n    d;\n  }\n  e;\n}\n";

    #[test]
    fn a_row_has_a_guide_per_level_of_indentation() {
        let guides = guides_for(CODE, 0);
        let levels: Vec<usize> = (0..8).map(|row| guides.levels_of(row)).collect();
        assert_eq!(levels, vec![0, 1, 2, 2, 2, 1, 1, 0]);
    }

    #[test]
    fn a_blank_row_takes_the_fewer_levels_of_its_neighbours() {
        let guides = guides_for("a {\n  b {\n    c\n\n  }\n}\n", 0);
        assert_eq!(guides.levels_of(3), 1);
        let guides = guides_for("a {\n  b;\n\n  c;\n}\n", 0);
        assert_eq!(guides.levels_of(2), 1);
        let guides = guides_for("a;\n\nb;\n", 0);
        assert_eq!(guides.levels_of(1), 0);
    }

    #[test]
    fn tabs_count_as_one_level_each() {
        let buffer = Buffer::from_text("a {\n\tb {\n\t\tc\n\t}\n}\n");
        let guides = Guides::compute(&buffer, 0..5, 0, IndentStyle::Tabs);
        assert_eq!(guides.levels_of(2), 2);
    }

    #[test]
    fn the_cursor_in_a_body_lights_the_guide_left_of_it_along_the_body() {
        let guides = guides_for(CODE, 4);
        assert_eq!(guides.scope(), Some(Scope { first_row: 2, last_row: 4, level: 1 }));
        assert!(guides.is_active(3, 1));
        assert!(!guides.is_active(3, 0));
        assert!(!guides.is_active(1, 1));
    }

    #[test]
    fn the_cursor_on_a_line_that_opens_a_block_lights_the_guide_of_its_body() {
        let guides = guides_for(CODE, 1);
        assert_eq!(guides.scope(), Some(Scope { first_row: 2, last_row: 4, level: 1 }));
        let guides = guides_for(CODE, 0);
        assert_eq!(guides.scope(), Some(Scope { first_row: 1, last_row: 6, level: 0 }));
    }

    #[test]
    fn the_cursor_on_a_line_that_closes_a_block_lights_the_guide_of_that_block() {
        let guides = guides_for(CODE, 5);
        assert_eq!(guides.scope(), Some(Scope { first_row: 2, last_row: 4, level: 1 }));
    }

    #[test]
    fn code_at_the_margin_that_opens_nothing_has_no_scope() {
        let guides = guides_for("a;\nb;\n", 1);
        assert_eq!(guides.scope(), None);
    }

    #[test]
    fn the_scope_runs_through_blank_lines_inside_the_block_but_stops_at_its_end() {
        let guides = guides_for("a {\n  b;\n\n  c;\n\nd;\n", 1);
        let scope = guides.scope().unwrap();
        assert_eq!((scope.first_row, scope.last_row), (1, 3));
    }

    #[test]
    fn rows_far_from_the_cursor_still_get_guides_and_no_scope_is_made_up() {
        let mut text = String::new();
        for _ in 0..4000 {
            text.push_str("a {\n  b;\n}\n");
        }
        let buffer = Buffer::from_text(&text);
        let guides = Guides::compute(&buffer, 9000..9030, 0, TWO);
        assert_eq!(guides.levels_of(9001), 1);
        assert_eq!(guides.scope(), None);
    }
}
