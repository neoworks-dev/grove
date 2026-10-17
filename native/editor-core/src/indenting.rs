//! Changing how lines are indented: one level more or less on every line a selection touches, and
//! the style a file is indented in.

use std::collections::BTreeSet;
use std::time::Instant;

use crate::buffer::{Buffer, Position};
use crate::command::Outcome;
use crate::edit::{Edit, Edits};
use crate::editing::{SelectionsAfter, edited};
use crate::history::EditKind;
use crate::indent::{IndentSource, IndentStyle, outdent_length};
use crate::selections::Selections;
use crate::state::EditorState;

impl EditorState {
    /// Indents, or with `outdent` unindents, every line a selection touches, keeping the
    /// selections around the text they were on.
    pub(crate) fn shift_lines(&mut self, outdent: bool, now: Instant) -> Outcome {
        let style = self.buffer.indent();
        let edits: Vec<Edit> = touched_rows(&self.selections)
            .into_iter()
            .filter_map(|row| shift_edit(&self.buffer, row, style, outdent))
            .collect();
        let changed = self.commit(Edits::new(edits), SelectionsAfter::KeepPlaces, EditKind::Other, now);
        edited(changed)
    }

    /// Gives a file whose own lines did not say how it is indented the default style. Returns
    /// whether that changed anything.
    pub fn apply_default_indent(&mut self, style: IndentStyle) -> bool {
        if self.buffer.indent_source() != IndentSource::Default || self.buffer.indent() == style {
            return false;
        }
        self.buffer.set_indent(style, IndentSource::Default);
        true
    }

    /// Sets the file's indentation style as a choice that changing the default does not undo.
    pub(crate) fn set_indent(&mut self, style: IndentStyle) -> Outcome {
        let changed = self.buffer.indent() != style || self.buffer.indent_source() != IndentSource::Chosen;
        self.buffer.set_indent(style, IndentSource::Chosen);
        Outcome { indent_changed: changed, ..Outcome::default() }
    }
}

/// The rows the selections touch. A selection that ends at the start of a line leaves that line out.
fn touched_rows(selections: &Selections) -> BTreeSet<usize> {
    let mut rows = BTreeSet::new();
    for selection in selections.all() {
        let (start, end) = (selection.start(), selection.end());
        let last = if end.column == 0 && end.row > start.row { end.row - 1 } else { end.row };
        rows.extend(start.row..=last);
    }
    rows
}

/// The edit that moves one row a level in or out, or none when there is nothing to do: an empty
/// line is not indented, and a line with no indentation cannot go further out.
fn shift_edit(buffer: &Buffer, row: usize, style: IndentStyle, outdent: bool) -> Option<Edit> {
    let line = buffer.line(row);
    let line_start = buffer.offset_of(Position { row, column: 0 });
    if !outdent {
        if line.is_empty() {
            return None;
        }
        return Some(Edit::replace(line_start..line_start, style.unit()));
    }
    let removed = outdent_length(&line, style);
    if removed == 0 {
        return None;
    }
    Some(Edit::replace(line_start..line_start + removed, ""))
}
