//! Operators: `d`, `c`, `y`, `>`, `<`, `gu`, `gU` and `g~` applied to what a motion, a text
//! object, some lines or a visual selection covers, at every cursor.

use std::time::Instant;

use crate::buffer::{Buffer, Position};
use crate::command::Outcome;
use crate::edit::Edit;
use crate::indent::outdent_length;
use crate::movement::Motion;
use crate::selections::Selection;
use crate::state::EditorState;
use crate::vim::motion::{MotionKind, change_word_end, first_non_blank_column, reach};
use crate::vim::objects::{ObjectRange, find_object};
use crate::vim::plan::{CursorSpec, Plan, clamp_to_line};
use crate::vim::registers::{Register, VimMemory};
use crate::vim::search::search_landing;
use crate::vim::types::{Operator, SelectionKind, Target};

/// What an operator takes at one cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Covered {
    /// Characters, from an offset up to, not including, another.
    Chars { start: usize, end: usize },
    /// Whole lines, counted from zero.
    Lines { first: usize, last: usize },
}

/// The offset where a row's text ends, before its line break.
pub fn line_end_offset(buffer: &Buffer, row: usize) -> usize {
    buffer.offset_of(Position { row, column: usize::MAX })
}

/// The text a range covers, as a register keeps it: whole lines without their last line break.
pub fn covered_text(buffer: &Buffer, covered: Covered) -> String {
    match covered {
        Covered::Chars { start, end } => buffer.slice(start..end),
        Covered::Lines { first, last } => {
            let lines: Vec<String> = (first..=last).map(|row| buffer.line(row)).collect();
            lines.join("\n")
        }
    }
}

/// What a motion covers from a cursor: the text between the cursor and where it lands, with
/// vim's rules for the odd cases. A motion that ends in the first column of a later line stops
/// at the end of the line before, and takes whole lines when it began at or before the first
/// non-blank. Changing a word does not take the white space after it.
fn covered_by_motion(
    buffer: &Buffer,
    selection: &Selection,
    motion: Motion,
    count: usize,
    operator: Operator,
) -> Option<Covered> {
    let head = selection.head;
    let head_offset = buffer.offset_of(head);
    if let (Operator::Change, Motion::WordForward { big }) = (operator, motion) {
        let on_word = buffer.rope().get_char(head_offset).is_some_and(|character| !character.is_whitespace());
        if on_word {
            let end = change_word_end(buffer.rope(), head_offset, big, count) + 1;
            return Some(Covered::Chars { start: head_offset, end });
        }
    }
    let reached = reach(buffer, selection, motion, count, true)?;
    let landing = reached.position;
    let landing_offset = buffer.offset_of(landing);
    match reached.kind {
        MotionKind::Linewise => {
            Some(Covered::Lines { first: head.row.min(landing.row), last: head.row.max(landing.row) })
        }
        MotionKind::Inclusive => {
            let (start, end) = (head_offset.min(landing_offset), head_offset.max(landing_offset));
            let line_end = line_end_offset(buffer, buffer.position_of(end).row);
            Some(Covered::Chars { start, end: (end + 1).min(line_end.max(end)) })
        }
        MotionKind::Exclusive => {
            let (first, second) = if head_offset <= landing_offset { (head, landing) } else { (landing, head) };
            exclusive_range(buffer, first, second)
        }
    }
}

/// The range an exclusive motion covers between two positions, with vim's exception for a
/// range that ends in the first column of a line.
fn exclusive_range(buffer: &Buffer, first: Position, second: Position) -> Option<Covered> {
    let ends_in_first_column = second.column == 0 && second.row > first.row;
    if !ends_in_first_column {
        return Some(Covered::Chars { start: buffer.offset_of(first), end: buffer.offset_of(second) });
    }
    let starts_at_or_before_text = first.column <= first_non_blank_column(&buffer.line(first.row));
    if starts_at_or_before_text {
        return Some(Covered::Lines { first: first.row, last: second.row - 1 });
    }
    let end = line_end_offset(buffer, second.row - 1);
    Some(Covered::Chars { start: buffer.offset_of(first), end })
}

/// What a target covers at one cursor, or none when it does not apply there.
fn resolve_target(
    buffer: &Buffer,
    memory: &mut VimMemory,
    selection: &Selection,
    target: &Target,
    operator: Operator,
) -> Option<Covered> {
    let head = selection.head;
    let last_row = buffer.line_count().saturating_sub(1);
    match target {
        Target::Motion { motion, count } => covered_by_motion(buffer, selection, *motion, *count, operator),
        Target::Object { object, around, count } => match find_object(buffer, head, *object, *around, *count)? {
            ObjectRange::Chars { start, end } => Some(Covered::Chars { start, end }),
            ObjectRange::Lines { first, last } => Some(Covered::Lines { first, last }),
        },
        Target::Lines { count } => {
            Some(Covered::Lines { first: head.row, last: (head.row + count.max(&1) - 1).min(last_row) })
        }
        Target::Selection { kind: SelectionKind::Lines } => {
            Some(Covered::Lines { first: selection.start().row, last: selection.end().row })
        }
        Target::Selection { kind: SelectionKind::Characters | SelectionKind::Block } => {
            let start = buffer.offset_of(selection.start());
            let end = (buffer.offset_of(selection.end()) + 1).min(buffer.length());
            Some(Covered::Chars { start, end })
        }
        Target::Search { request, count } => {
            let landing = search_landing(buffer, memory, selection, request, *count)?;
            let head_offset = buffer.offset_of(head);
            Some(Covered::Chars { start: head_offset.min(landing), end: head_offset.max(landing) })
        }
    }
}

/// The text a case operator turns `text` into.
fn changed_case(operator: Operator, text: &str) -> String {
    match operator {
        Operator::Lowercase => text.to_lowercase(),
        Operator::Uppercase => text.to_uppercase(),
        _ => text
            .chars()
            .map(|character| {
                if character.is_lowercase() {
                    character.to_uppercase().collect::<String>()
                } else {
                    character.to_lowercase().collect::<String>()
                }
            })
            .collect(),
    }
}

/// The rows a range touches.
fn rows_of(buffer: &Buffer, covered: Covered) -> (usize, usize) {
    match covered {
        Covered::Lines { first, last } => (first, last),
        Covered::Chars { start, end } => {
            let last_offset = end.saturating_sub(1).max(start);
            (buffer.position_of(start).row, buffer.position_of(last_offset).row)
        }
    }
}

/// The edit that removes whole lines, with the line break that goes with them: the one after
/// the last line, or the one before the first when the last line is also the end of the text.
fn line_removal(buffer: &Buffer, first: usize, last: usize) -> Edit {
    let last_row = buffer.line_count().saturating_sub(1);
    if last < last_row {
        let start = buffer.offset_of(Position { row: first, column: 0 });
        let end = buffer.offset_of(Position { row: last + 1, column: 0 });
        return Edit::replace(start..end, "");
    }
    if first == 0 {
        return Edit::replace(0..buffer.length(), "");
    }
    let start = line_end_offset(buffer, first - 1);
    Edit::replace(start..buffer.length(), "")
}

/// The whitespace a line starts with.
fn indentation_of(buffer: &Buffer, row: usize) -> String {
    buffer.line(row).chars().take_while(|character| character.is_whitespace()).collect()
}

/// The plan for removing a range, which `d` and `c` share. A change of whole lines leaves one
/// empty line behind that keeps the indentation.
fn removal_plan(buffer: &Buffer, covered: Covered, operator: Operator) -> Plan {
    match (covered, operator) {
        (Covered::Chars { start, end }, _) => {
            Plan::single(Edit::replace(start..end, ""), CursorSpec::InReplacement { edit: 0, offset: 0 })
        }
        (Covered::Lines { first, last }, Operator::Change) => {
            let indentation = indentation_of(buffer, first);
            let start = buffer.offset_of(Position { row: first, column: 0 });
            let end = line_end_offset(buffer, last);
            let length = indentation.chars().count();
            Plan::single(Edit::replace(start..end, indentation), CursorSpec::InReplacement { edit: 0, offset: length })
        }
        (Covered::Lines { first, last }, _) => {
            let removes_the_end = last + 1 >= buffer.line_count() && first > 0;
            let near = if removes_the_end {
                line_end_offset(buffer, first - 1)
            } else {
                buffer.offset_of(Position { row: first, column: 0 })
            };
            Plan::single(line_removal(buffer, first, last), CursorSpec::FirstNonBlankNear(near))
        }
    }
}

/// The plan for shifting the lines a range touches left or right.
fn shift_plan(buffer: &Buffer, covered: Covered, operator: Operator) -> Plan {
    let (first, last) = rows_of(buffer, covered);
    let mut edits = Vec::new();
    for row in first..=last {
        let line_start = buffer.offset_of(Position { row, column: 0 });
        let line = buffer.line(row);
        if operator == Operator::Indent {
            if !line.is_empty() {
                edits.push(Edit::replace(line_start..line_start, buffer.indent().unit()));
            }
            continue;
        }
        let removed = outdent_length(&line, buffer.indent());
        if removed > 0 {
            edits.push(Edit::replace(line_start..line_start + removed, ""));
        }
    }
    let near = buffer.offset_of(Position { row: first, column: 0 });
    if edits.is_empty() {
        edits.push(Edit::replace(near..near, ""));
    }
    Plan { edits, cursor: CursorSpec::FirstNonBlankNear(near) }
}

/// The plan for changing the case of a range. Lines are changed from their first character to their last.
fn case_plan(buffer: &Buffer, covered: Covered, operator: Operator, head_offset: usize) -> Plan {
    let (start, end, cursor) = match covered {
        Covered::Chars { start, end } => (start, end, CursorSpec::InReplacement { edit: 0, offset: 0 }),
        Covered::Lines { first, last } => (
            buffer.offset_of(Position { row: first, column: 0 }),
            line_end_offset(buffer, last),
            CursorSpec::AtOldOffset(head_offset),
        ),
    };
    let replacement = changed_case(operator, &buffer.slice(start..end));
    Plan::single(Edit::replace(start..end, replacement), cursor)
}

impl EditorState {
    /// Applies an operator at every cursor.
    pub(crate) fn operate(
        &mut self,
        operator: Operator,
        target: &Target,
        register_name: Option<char>,
        now: Instant,
    ) -> Outcome {
        let selections: Vec<Selection> = self.selections.all().to_vec();
        let covered: Vec<Option<Covered>> = selections
            .iter()
            .map(|selection| resolve_target(&self.buffer, &mut self.memory, selection, target, operator))
            .collect();
        if covered.iter().all(Option::is_none) {
            return Outcome::default();
        }
        let mut outcome = Outcome { reveal_newest: true, ..Outcome::default() };
        if matches!(operator, Operator::Delete | Operator::Change | Operator::Yank) {
            let blockwise = matches!(target, Target::Selection { kind: SelectionKind::Block });
            outcome.copied = self.remember(&covered, register_name, operator == Operator::Yank, blockwise);
        }
        if operator == Operator::Yank {
            self.cursors_after_yank(&selections, &covered);
            return outcome;
        }
        let plans: Vec<Plan> = selections
            .iter()
            .zip(&covered)
            .map(|(selection, covered)| self.operator_plan(operator, selection, *covered))
            .collect();
        let changed = self.commit_plans(plans, operator != Operator::Change, now);
        outcome.text_changed = changed;
        outcome.changed = changed;
        outcome
    }

    /// Stores what the operator covers in a register, and gives back the text for the system
    /// clipboard when the register is one.
    fn remember(
        &mut self,
        covered: &[Option<Covered>],
        register_name: Option<char>,
        is_yank: bool,
        blockwise: bool,
    ) -> Option<String> {
        let taken: Vec<Covered> = covered.iter().flatten().copied().collect();
        let linewise = taken.iter().any(|covered| matches!(covered, Covered::Lines { .. }));
        let texts = taken.iter().map(|covered| covered_text(&self.buffer, *covered)).collect();
        let register = Register { texts, linewise, blockwise };
        let clipboard = matches!(register_name, Some('+') | Some('*')).then(|| register.clipboard_text());
        self.memory.record(register_name, register, is_yank);
        clipboard
    }

    /// The plan for one cursor's part of an operator that changes the text.
    fn operator_plan(&self, operator: Operator, selection: &Selection, covered: Option<Covered>) -> Plan {
        let head_offset = self.buffer.offset_of(selection.head);
        let Some(covered) = covered else {
            return Plan::single(Edit::replace(head_offset..head_offset, ""), CursorSpec::AtOldOffset(head_offset));
        };
        match operator {
            Operator::Delete | Operator::Change => removal_plan(&self.buffer, covered, operator),
            Operator::Indent | Operator::Outdent => shift_plan(&self.buffer, covered, operator),
            _ => case_plan(&self.buffer, covered, operator, head_offset),
        }
    }

    /// Puts each cursor where a yank leaves it: at the start of what was copied.
    fn cursors_after_yank(&mut self, selections: &[Selection], covered: &[Option<Covered>]) {
        let positions = selections
            .iter()
            .zip(covered)
            .map(|(selection, covered)| match covered {
                Some(Covered::Chars { start, .. }) => self.buffer.position_of(*start),
                Some(Covered::Lines { first, .. }) => {
                    clamp_to_line(&self.buffer, Position { row: *first, column: selection.head.column })
                }
                None => selection.head,
            })
            .collect();
        self.place_cursors(positions);
    }
}
