//! The commands that change text. Each one plans an edit per selection against the text as it
//! is now, and they all go through [`EditorState::commit`], which applies them together, moves
//! the selections and the anchors, and records one undo step. Nothing here applies edits one
//! selection after another, so no selection ever works from a position an earlier one moved.

use std::time::Instant;

use crate::anchor::{Anchor, AnchorId, Bias};
use crate::buffer::{Buffer, Position};
use crate::clipboard::{copy_text, split_for_paste};
use crate::command::Outcome;
use crate::completion::RangeEdit;
use crate::display::DisplayLine;
use crate::edit::{Edit, Edits};
use crate::history::{EditKind, Step, Transaction};
use crate::indent::IndentStyle;
use crate::movement::{Motion, move_selection};
use crate::selections::{Selection, Selections};
use crate::state::EditorState;

/// Where the selections end up after an edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectionsAfter {
    /// Every selection became the text of its own edit, and is now a cursor after that text.
    CursorAfterEachEdit,
    /// One edit was made somewhere. The newest selection becomes a cursor after it, and the
    /// others keep their place around it.
    CursorAfterTheEdit,
    /// Every selection keeps its place in the text around the edits.
    KeepPlaces,
    /// Like `KeepPlaces`, but an end of a selection that is at or inside replaced text goes to
    /// before it, so a cursor where a formatter rewrote the text stays where the person put it.
    StayBeforeReplacements,
}

impl EditorState {
    /// Types text at every selection, or finishes the composition if there is one.
    pub(crate) fn insert_text(&mut self, text: &str, now: Instant) -> Outcome {
        if self.marked.is_some() {
            return self.finish_composition(text, now);
        }
        let nothing_selected = self.selections.all().iter().all(|selection| selection.is_empty());
        let kind = if nothing_selected { EditKind::Typing(text) } else { EditKind::Other };
        let changed = self.edit_each_selection(kind, now, |buffer, _, selection| insertion(buffer, selection, text));
        edited(changed)
    }

    /// Deletes each selection, or what a motion crosses from each cursor.
    pub(crate) fn delete(&mut self, motion: Motion, now: Instant) -> Outcome {
        let changed =
            self.edit_each_selection(EditKind::Other, now, |buffer, _, selection| deletion(buffer, selection, motion));
        edited(changed)
    }

    /// Replaces each selection with a line break that keeps the line's indentation.
    pub(crate) fn insert_newline(&mut self, now: Instant) -> Outcome {
        let changed = self.edit_each_selection(EditKind::Other, now, |buffer, _, selection| {
            insertion(buffer, selection, &newline_text(buffer, selection))
        });
        edited(changed)
    }

    /// Replaces each selection with a tab or the spaces up to the next indent stop. Where a
    /// selection covers several lines, indents those lines instead.
    pub(crate) fn insert_tab(&mut self, now: Instant) -> Outcome {
        if self.selections.all().iter().any(|selection| selection.start().row != selection.end().row) {
            return self.shift_lines(false, now);
        }
        let changed = self.edit_each_selection(EditKind::Other, now, |buffer, _, selection| {
            insertion(buffer, selection, &tab_text(buffer, selection))
        });
        edited(changed)
    }

    /// Copies the selected text, or the lines of the cursors, and remembers whether those were lines.
    pub(crate) fn copy(&mut self) -> Outcome {
        let copied = copy_text(&self.buffer, &self.selections);
        self.whole_line_copy = copied.whole_lines.then(|| copied.text.clone());
        Outcome { copied: Some(copied.text), ..Outcome::default() }
    }

    /// Copies, then deletes the selected text, or the lines that were copied.
    pub(crate) fn cut(&mut self, now: Instant) -> Outcome {
        let mut outcome = self.copy();
        let whole_lines = self.whole_line_copy.is_some();
        let changed = self.edit_each_selection(EditKind::Other, now, |buffer, _, selection| {
            if whole_lines {
                return line_deletion(buffer, selection.head.row);
            }
            deletion_of_selection(buffer, selection)
        });
        outcome.text_changed = changed;
        outcome.reveal_newest = changed;
        outcome.changed = changed;
        outcome
    }

    /// Pastes text over the selections.
    pub(crate) fn paste(&mut self, text: &str, now: Instant) -> Outcome {
        let nothing_selected = self.selections.all().iter().all(|selection| selection.is_empty());
        let whole_lines = nothing_selected && self.whole_line_copy.as_deref() == Some(text);
        let pieces = split_for_paste(text, self.selections.count(), whole_lines);
        let selections_after =
            if whole_lines { SelectionsAfter::KeepPlaces } else { SelectionsAfter::CursorAfterEachEdit };
        let changed = self.plan_and_commit(EditKind::Other, selections_after, now, |buffer, index, selection| {
            if whole_lines {
                return line_start_insertion(buffer, selection.head.row, &pieces[index]);
            }
            insertion(buffer, selection, &pieces[index])
        });
        edited(changed)
    }

    /// Replaces the composed text, or the newest selection, with text that stays composed.
    pub(crate) fn set_marked_text(&mut self, text: &str, now: Instant) -> Outcome {
        let (start, end) = self.composition_range();
        let changed = self.commit(
            Edits::new(vec![Edit::replace(start..end, text)]),
            SelectionsAfter::CursorAfterTheEdit,
            EditKind::Composing,
            now,
        );
        self.clear_marked();
        if !text.is_empty() {
            let length = text.chars().count();
            self.marked = Some(self.pin_range(start, start + length));
        }
        edited(changed)
    }

    /// Types text in place of the composed text and ends the composition.
    fn finish_composition(&mut self, text: &str, now: Instant) -> Outcome {
        let (start, end) = self.composition_range();
        let changed = self.commit(
            Edits::new(vec![Edit::replace(start..end, text)]),
            SelectionsAfter::CursorAfterTheEdit,
            EditKind::Composing,
            now,
        );
        self.clear_marked();
        self.history.close_group();
        edited(changed)
    }

    /// Replaces a range of characters and puts the newest cursor after the new text.
    pub(crate) fn replace_range(&mut self, start: usize, end: usize, text: &str, now: Instant) -> Outcome {
        let length = self.buffer.length();
        let (start, end) = (start.min(length), end.min(length));
        let edits = Edits::new(vec![Edit::replace(start.min(end)..end.max(start), text)]);
        let changed = self.commit(edits, SelectionsAfter::CursorAfterTheEdit, EditKind::Other, now);
        edited(changed)
    }

    /// Replaces several ranges at once, which are positions in the text as it is now, as one step
    /// for undo. Selections keep their place in the text around the edits, and one at or inside
    /// replaced text goes to before it.
    pub(crate) fn apply_range_edits(&mut self, edits: &[RangeEdit], now: Instant) -> Outcome {
        let mut list: Vec<Edit> = edits
            .iter()
            .map(|edit| {
                let start = self.buffer.offset_of(edit.start);
                let end = self.buffer.offset_of(edit.end).max(start);
                Edit::replace(start..end, edit.text.clone())
            })
            .collect();
        list.sort_by_key(|edit| (edit.start, edit.end));
        let changed = self.commit(Edits::new(list), SelectionsAfter::StayBeforeReplacements, EditKind::Other, now);
        edited(changed)
    }

    /// Makes the text read `text` as one step for undo, replacing only the stretch that differs,
    /// so selections and anchors outside it keep their place. Says whether the text changed.
    pub(crate) fn replace_differing_text(&mut self, text: &str, now: Instant) -> bool {
        let current = self.buffer.rope().to_string();
        let Some((start, end, replacement)) = differing_stretch(&current, text) else {
            return false;
        };
        let edits = Edits::new(vec![Edit::replace(start..end, replacement)]);
        self.commit(edits, SelectionsAfter::StayBeforeReplacements, EditKind::Other, now)
    }

    /// The composed text's range, or the newest selection's range when nothing is composed.
    fn composition_range(&self) -> (usize, usize) {
        if let Some((start, end)) = self.marked {
            let start = self.anchors.get(start).map(|anchor| anchor.offset);
            let end = self.anchors.get(end).map(|anchor| anchor.offset);
            if let (Some(start), Some(end)) = (start, end) {
                return (start, end);
            }
        }
        let newest = self.selections.newest();
        (self.buffer.offset_of(newest.start()), self.buffer.offset_of(newest.end()))
    }

    /// Anchors for the two ends of a range of text: the start stays before text inserted at
    /// it and the end moves after.
    fn pin_range(&mut self, start: usize, end: usize) -> (AnchorId, AnchorId) {
        let start_anchor = self.anchors.insert(Anchor { offset: start, bias: Bias::Left });
        let end_anchor = self.anchors.insert(Anchor { offset: end, bias: Bias::Right });
        (start_anchor, end_anchor)
    }

    /// Forgets the composed text's range.
    pub(crate) fn clear_marked(&mut self) {
        let Some((start, end)) = self.marked.take() else {
            return;
        };
        self.anchors.remove(start);
        self.anchors.remove(end);
    }

    /// Plans one edit per selection, in order, and commits them together. Returns whether
    /// the text changed.
    fn edit_each_selection(
        &mut self,
        kind: EditKind,
        now: Instant,
        plan: impl FnMut(&Buffer, usize, &Selection) -> Edit,
    ) -> bool {
        self.plan_and_commit(kind, SelectionsAfter::CursorAfterEachEdit, now, plan)
    }

    /// Like `edit_each_selection`, with a say in where the selections end up.
    fn plan_and_commit(
        &mut self,
        kind: EditKind,
        selections_after: SelectionsAfter,
        now: Instant,
        mut plan: impl FnMut(&Buffer, usize, &Selection) -> Edit,
    ) -> bool {
        let planned: Vec<Edit> = self
            .selections
            .all()
            .iter()
            .enumerate()
            .map(|(index, selection)| plan(&self.buffer, index, selection))
            .collect();
        self.commit(Edits::new(planned), selections_after, kind, now)
    }

    /// Applies edits, moves the selections as asked, and records the change for undo. Returns
    /// false, changing nothing, when the edits change nothing.
    pub(crate) fn commit(
        &mut self,
        edits: Edits,
        selections_after: SelectionsAfter,
        kind: EditKind,
        now: Instant,
    ) -> bool {
        self.commit_placing(edits, kind, now, |state, edits, old_offsets| {
            state.selections_after_edit(edits, old_offsets, selections_after)
        })
    }

    /// Like `commit`, with `place` working out the selections from the edits and the new text.
    pub(crate) fn commit_placing(
        &mut self,
        edits: Edits,
        kind: EditKind,
        now: Instant,
        place: impl FnOnce(&EditorState, &Edits, &[(usize, usize)]) -> Selections,
    ) -> bool {
        if edits.is_noop() {
            return false;
        }
        let selections_before = self.selections.clone();
        let old_offsets = self.selection_offsets();
        let inverse = self.replace_text(&edits);
        self.selections = place(self, &edits, &old_offsets);
        let revision_before = self.revision;
        self.next_revision += 1;
        self.revision = self.next_revision;
        let transaction = Transaction {
            steps: vec![Step { edits, inverse }],
            selections_before,
            selections_after: self.selections.clone(),
            revision_before,
            revision_after: self.revision,
        };
        self.history.record(transaction, kind, now);
        true
    }

    /// Where every selection's anchor and head are, as offsets in the text.
    fn selection_offsets(&self) -> Vec<(usize, usize)> {
        let offset_of = |position| self.buffer.offset_of(position);
        self.selections.all().iter().map(|selection| (offset_of(selection.anchor), offset_of(selection.head))).collect()
    }

    /// The selections once `edits` are in the buffer. `old_offsets` are the selections' ends
    /// as they were before.
    fn selections_after_edit(
        &self,
        edits: &Edits,
        old_offsets: &[(usize, usize)],
        selections_after: SelectionsAfter,
    ) -> Selections {
        let replacements = edits.replacement_ranges();
        let newest = self.selections.newest_index();
        let mut list = Vec::with_capacity(old_offsets.len());
        for (index, (anchor, head)) in old_offsets.iter().enumerate() {
            let after_text = match selections_after {
                SelectionsAfter::CursorAfterEachEdit => Some(replacements[index].end),
                SelectionsAfter::CursorAfterTheEdit if index == newest => Some(replacements[0].end),
                SelectionsAfter::CursorAfterTheEdit
                | SelectionsAfter::KeepPlaces
                | SelectionsAfter::StayBeforeReplacements => None,
            };
            if let Some(offset) = after_text {
                list.push(Selection::cursor(self.buffer.position_of(offset)));
                continue;
            }
            if selections_after == SelectionsAfter::StayBeforeReplacements {
                let anchor = self.buffer.position_of(edits.map_offset(*anchor, Bias::Left));
                let head = self.buffer.position_of(edits.map_offset(*head, Bias::Left));
                list.push(Selection::spanning(anchor, head));
                continue;
            }
            list.push(self.selection_through(edits, *anchor, *head));
        }
        Selections::from_list(list, newest)
    }

    /// A selection moved through edits: its later end sticks to the right of text inserted at it,
    /// its earlier end to the left, so inserting at either end stays outside the selection.
    fn selection_through(&self, edits: &Edits, anchor: usize, head: usize) -> Selection {
        let (anchor_bias, head_bias) = if anchor == head {
            (Bias::Right, Bias::Right)
        } else if anchor < head {
            (Bias::Left, Bias::Right)
        } else {
            (Bias::Right, Bias::Left)
        };
        let mapped_anchor = edits.map_offset(anchor, anchor_bias);
        let mapped_head = edits.map_offset(head, head_bias);
        Selection::spanning(self.buffer.position_of(mapped_anchor), self.buffer.position_of(mapped_head))
    }

    /// Puts edits into the buffer and moves every anchor through them. Returns the edits that undo them.
    pub(crate) fn replace_text(&mut self, edits: &Edits) -> Edits {
        let inverse = self.buffer.apply_edits(edits);
        self.anchors.apply_edits(edits);
        inverse
    }

    /// Takes back the last transaction. Returns whether there was one.
    pub(crate) fn undo(&mut self) -> bool {
        let Some(transaction) = self.history.take_undo() else {
            return false;
        };
        for step in transaction.steps.iter().rev() {
            self.replace_text(&step.inverse);
        }
        self.selections = transaction.selections_before.clone();
        self.revision = transaction.revision_before;
        self.clear_marked();
        self.history.push_redo(transaction);
        true
    }

    /// Does again the last transaction that was taken back. Returns whether there was one.
    pub(crate) fn redo(&mut self) -> bool {
        let Some(transaction) = self.history.take_redo() else {
            return false;
        };
        for step in &transaction.steps {
            self.replace_text(&step.edits);
        }
        self.selections = transaction.selections_after.clone();
        self.revision = transaction.revision_after;
        self.clear_marked();
        self.history.push_undo(transaction);
        true
    }
}

/// An outcome for a command that edits: if the text changed, the view follows the newest cursor.
pub(crate) fn edited(changed: bool) -> Outcome {
    Outcome { text_changed: changed, reveal_newest: changed, changed, ..Outcome::default() }
}

/// The stretch of `old` that has to be replaced to make it `new`, as character offsets into
/// `old` and the text that goes there, found by trimming what both start and end with. None
/// when the two are the same.
fn differing_stretch(old: &str, new: &str) -> Option<(usize, usize, String)> {
    let old: Vec<char> = old.chars().collect();
    let new: Vec<char> = new.chars().collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    if prefix == old.len() && prefix == new.len() {
        return None;
    }
    let old_rest = &old[prefix..];
    let new_rest = &new[prefix..];
    let suffix = old_rest.iter().rev().zip(new_rest.iter().rev()).take_while(|(a, b)| a == b).count();
    let replacement: String = new_rest[..new_rest.len() - suffix].iter().collect();
    Some((prefix, old.len() - suffix, replacement))
}

/// Replaces a selection with text.
fn insertion(buffer: &Buffer, selection: &Selection, text: &str) -> Edit {
    let start = buffer.offset_of(selection.start());
    let end = buffer.offset_of(selection.end());
    Edit::replace(start..end, text)
}

/// Inserts text at the start of a row.
fn line_start_insertion(buffer: &Buffer, row: usize, text: &str) -> Edit {
    let offset = buffer.offset_of(Position { row, column: 0 });
    Edit::replace(offset..offset, text)
}

/// Deletes a selection, or nothing when it is only a cursor.
fn deletion_of_selection(buffer: &Buffer, selection: &Selection) -> Edit {
    let start = buffer.offset_of(selection.start());
    let end = buffer.offset_of(selection.end());
    Edit::replace(start..end, "")
}

/// Deletes a selection, or the text between a cursor and where the motion takes it.
fn deletion(buffer: &Buffer, selection: &Selection, motion: Motion) -> Edit {
    if !selection.is_empty() {
        return deletion_of_selection(buffer, selection);
    }
    let moved = move_selection(buffer, selection, motion, false);
    let from = buffer.offset_of(selection.head);
    let to = buffer.offset_of(moved.head);
    Edit::replace(from.min(to)..from.max(to), "")
}

/// Deletes a whole row with its line break.
fn line_deletion(buffer: &Buffer, row: usize) -> Edit {
    let start = buffer.offset_of(Position { row, column: 0 });
    let end = buffer.offset_of(Position { row: row + 1, column: 0 });
    if row + 1 >= buffer.line_count() {
        return Edit::replace(start..buffer.length(), "");
    }
    Edit::replace(start..end, "")
}

/// A line break and the whitespace the line starts with, as far as the selection's start. After an
/// opening bracket there is one more level of indentation, unless the bracket is closed right there.
fn newline_text(buffer: &Buffer, selection: &Selection) -> String {
    let start = selection.start();
    let line = buffer.line(start.row);
    let indentation: String =
        line.chars().take(start.column).take_while(|character| character.is_whitespace()).collect();
    if opens_block(&line, start.column) {
        return format!("\n{indentation}{}", buffer.indent().unit());
    }
    format!("\n{indentation}")
}

/// Whether the character before a column opens a bracket that the character after it does not close.
fn opens_block(line: &str, column: usize) -> bool {
    let characters: Vec<char> = line.chars().collect();
    let Some(previous) = column.checked_sub(1).and_then(|before| characters.get(before)) else {
        return false;
    };
    let closer = match previous {
        '{' => '}',
        '(' => ')',
        '[' => ']',
        _ => return false,
    };
    characters.get(column) != Some(&closer)
}

/// A tab in a file that uses them, else the spaces up to the next indent stop.
fn tab_text(buffer: &Buffer, selection: &Selection) -> String {
    let width = match buffer.indent() {
        IndentStyle::Tabs => return "\t".to_string(),
        IndentStyle::Spaces { width } => width.max(1),
    };
    let start = selection.start();
    let before: String = buffer.line(start.row).chars().take(start.column).collect();
    let display_column = DisplayLine::new(&before).text.chars().count();
    " ".repeat(width - display_column % width)
}
