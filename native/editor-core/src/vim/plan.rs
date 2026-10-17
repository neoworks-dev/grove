//! How vim's commands change the text at every cursor at once. Each cursor makes a `Plan`: the
//! edits it wants and where its cursor ends up. They are committed together as one transaction,
//! so undo takes back a command at every cursor in one step.

use std::time::Instant;

use crate::anchor::Bias;
use crate::buffer::{Buffer, Position};
use crate::edit::{Edit, Edits};
use crate::history::EditKind;
use crate::selections::{Selection, Selections};
use crate::state::EditorState;
use crate::vim::motion::first_non_blank_column;

/// Where a cursor ends up after its edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorSpec {
    /// This many characters into the new text of one of the plan's edits.
    InReplacement { edit: usize, offset: usize },
    /// Where an offset in the text before the edits is afterwards.
    AtOldOffset(usize),
    /// The first character that is not white space on the line where an offset in the old text is afterwards.
    FirstNonBlankNear(usize),
}

/// What one cursor wants done.
pub struct Plan {
    pub edits: Vec<Edit>,
    pub cursor: CursorSpec,
}

impl Plan {
    /// A plan of one edit.
    pub fn single(edit: Edit, cursor: CursorSpec) -> Self {
        Plan { edits: vec![edit], cursor }
    }
}

/// Moves a position back onto a character of its line, which is where a cursor rests in
/// normal mode. An empty line has none, and keeps column zero.
pub fn clamp_to_line(buffer: &Buffer, position: Position) -> Position {
    let position = buffer.clamp(position);
    let last_column = buffer.line_length(position.row).saturating_sub(1);
    Position { row: position.row, column: position.column.min(last_column) }
}

impl EditorState {
    /// Applies the plans, one per cursor in the cursors' order, as a single transaction. Cursors
    /// end up as each plan says, and are moved back onto a character of their line when
    /// `clamp` is set. Returns whether the text changed.
    pub(crate) fn commit_plans(&mut self, plans: Vec<Plan>, clamp: bool, now: Instant) -> bool {
        let mut numbered: Vec<(usize, Edit)> = Vec::new();
        let mut first_edit_of_plan: Vec<usize> = Vec::new();
        for plan in &plans {
            first_edit_of_plan.push(numbered.len());
            for edit in &plan.edits {
                numbered.push((numbered.len(), edit.clone()));
            }
        }
        numbered.sort_by_key(|(number, edit)| (edit.start, *number));
        let mut sorted_index_of = vec![0; numbered.len()];
        for (sorted_index, (number, _)) in numbered.iter().enumerate() {
            sorted_index_of[*number] = sorted_index;
        }
        let edits = Edits::new(numbered.into_iter().map(|(_, edit)| edit).collect());
        let newest = self.selections.newest_index().min(plans.len().saturating_sub(1));
        self.commit_placing(edits, EditKind::Other, now, |state, edits, _| {
            let replacements = edits.replacement_ranges();
            let mut list = Vec::with_capacity(plans.len());
            for (index, plan) in plans.iter().enumerate() {
                let position = match plan.cursor {
                    CursorSpec::InReplacement { edit, offset } => {
                        let number = first_edit_of_plan[index] + edit;
                        state.buffer.position_of(replacements[sorted_index_of[number]].start + offset)
                    }
                    CursorSpec::AtOldOffset(old) => state.buffer.position_of(edits.map_offset(old, Bias::Left)),
                    CursorSpec::FirstNonBlankNear(old) => {
                        let row = state.buffer.position_of(edits.map_offset(old, Bias::Left)).row;
                        Position { row, column: first_non_blank_column(&state.buffer.line(row)) }
                    }
                };
                let position = if clamp { clamp_to_line(&state.buffer, position) } else { position };
                list.push(Selection::cursor(position));
            }
            Selections::from_list(list, newest)
        })
    }

    /// Puts one cursor at each position, the first being the newest unless another is given.
    pub(crate) fn place_cursors(&mut self, positions: Vec<Position>) {
        let newest = self.selections.newest_index().min(positions.len().saturating_sub(1));
        let list = positions.into_iter().map(Selection::cursor).collect();
        self.selections = Selections::from_list(list, newest);
    }
}
