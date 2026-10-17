//! Every cursor is a selection: an anchor where it started and a head where it is now,
//! empty when the two meet. The editor keeps any number of them, the way VS Code and Zed
//! do, sorted and never overlapping, so each edit and each paint walks them in order.

use crate::buffer::Position;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub anchor: Position,
    pub head: Position,
    /// The column up and down aim for, so moving through a short line and back keeps it.
    pub goal_column: Option<usize>,
}

impl Selection {
    /// An empty selection: a plain cursor.
    pub fn cursor(at: Position) -> Self {
        Selection { anchor: at, head: at, goal_column: None }
    }

    /// A selection from `anchor` to `head`.
    pub fn spanning(anchor: Position, head: Position) -> Self {
        Selection { anchor, head, goal_column: None }
    }

    /// Whether the selection is only a cursor.
    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }

    /// The earlier end.
    pub fn start(&self) -> Position {
        self.anchor.min(self.head)
    }

    /// The later end.
    pub fn end(&self) -> Position {
        self.anchor.max(self.head)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selections {
    /// Sorted by start, none overlapping.
    list: Vec<Selection>,
    /// The index in `list` of the one added last, which the view follows and Ctrl-D grows from.
    newest: usize,
}

impl Selections {
    /// One cursor at a position.
    pub fn single(at: Position) -> Self {
        Selections { list: vec![Selection::cursor(at)], newest: 0 }
    }

    /// Selections from a list in any order, with the one at `newest` as the newest. Any that
    /// overlap are merged.
    pub fn from_list(list: Vec<Selection>, newest: usize) -> Self {
        let mut selections = Selections { newest: newest.min(list.len() - 1), list };
        selections.normalize();
        selections
    }

    /// All selections, in order.
    pub fn all(&self) -> &[Selection] {
        &self.list
    }

    /// The selection added last.
    pub fn newest(&self) -> Selection {
        self.list[self.newest]
    }

    /// Where the newest selection is in `all()`.
    pub fn newest_index(&self) -> usize {
        self.newest
    }

    /// How many there are.
    pub fn count(&self) -> usize {
        self.list.len()
    }

    /// The selections that touch rows `first..end`, found by binary search so a paint does not
    /// walk thousands of cursors far off screen.
    pub fn in_rows(&self, first: usize, end: usize) -> &[Selection] {
        let from = self.list.partition_point(|selection| selection.end().row < first);
        let to = self.list.partition_point(|selection| selection.start().row < end);
        &self.list[from..to.max(from)]
    }

    /// Replaces every selection with what `change` makes of it, then merges any that now overlap.
    pub fn transform(&mut self, mut change: impl FnMut(&Selection) -> Selection) {
        for selection in &mut self.list {
            *selection = change(selection);
        }
        self.normalize();
    }

    /// Adds a selection, which becomes the newest.
    pub fn add(&mut self, selection: Selection) {
        self.list.push(selection);
        self.newest = self.list.len() - 1;
        self.normalize();
    }

    /// Replaces the newest selection.
    pub fn replace_newest(&mut self, selection: Selection) {
        self.list[self.newest] = selection;
        self.normalize();
    }

    /// Removes the empty selection at a position, unless it is the only one. Returns whether
    /// one was removed.
    pub fn remove_cursor_at(&mut self, at: Position) -> bool {
        if self.list.len() == 1 {
            return false;
        }
        let Some(index) = self.list.iter().position(|selection| selection.is_empty() && selection.head == at) else {
            return false;
        };
        self.list.remove(index);
        if self.newest >= index && self.newest > 0 {
            self.newest -= 1;
        }
        true
    }

    /// Drops every selection but the newest. Returns whether there were others.
    pub fn keep_only_newest(&mut self) -> bool {
        if self.list.len() == 1 {
            return false;
        }
        self.list = vec![self.newest()];
        self.newest = 0;
        true
    }

    /// Sorts the selections and merges those that overlap or are cursors at the same place,
    /// keeping track of which one is newest.
    fn normalize(&mut self) {
        let newest = self.list[self.newest];
        self.list.sort_by_key(|selection| (selection.start(), selection.end()));
        let mut merged: Vec<Selection> = Vec::with_capacity(self.list.len());
        let mut newest_index = 0;
        for selection in self.list.drain(..) {
            let is_newest = selection == newest;
            match merged.last_mut() {
                Some(previous) if overlaps(previous, &selection) => *previous = union(previous, &selection),
                _ => merged.push(selection),
            }
            if is_newest {
                newest_index = merged.len() - 1;
            }
        }
        self.list = merged;
        self.newest = newest_index;
    }
}

/// Whether `next`, which starts no earlier than `previous`, runs into it. Two selections that
/// only touch stay apart, as in VS Code, unless one is a cursor sitting on the other's edge.
fn overlaps(previous: &Selection, next: &Selection) -> bool {
    if next.start() < previous.end() {
        return true;
    }
    next.start() == previous.end() && (previous.is_empty() || next.is_empty())
}

/// One selection covering both, pointing the way the first one did.
fn union(first: &Selection, second: &Selection) -> Selection {
    let start = first.start().min(second.start());
    let end = first.end().max(second.end());
    if first.head < first.anchor {
        return Selection::spanning(end, start);
    }
    Selection::spanning(start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    #[test]
    fn cursors_stay_sorted() {
        let mut selections = Selections::single(at(5, 0));
        selections.add(Selection::cursor(at(1, 0)));
        let rows: Vec<usize> = selections.all().iter().map(|selection| selection.head.row).collect();
        assert_eq!(rows, vec![1, 5]);
        assert_eq!(selections.newest().head, at(1, 0));
    }

    #[test]
    fn cursors_that_meet_merge() {
        let mut selections = Selections::single(at(0, 3));
        selections.add(Selection::cursor(at(1, 0)));
        selections.transform(|_| Selection::cursor(at(0, 0)));
        assert_eq!(selections.count(), 1);
    }

    #[test]
    fn overlapping_selections_merge_and_keep_their_direction() {
        let mut selections = Selections::single(at(0, 0));
        selections.replace_newest(Selection::spanning(at(0, 4), at(0, 0)));
        selections.add(Selection::spanning(at(0, 6), at(0, 2)));
        assert_eq!(selections.all(), &[Selection::spanning(at(0, 6), at(0, 0))]);
    }

    #[test]
    fn touching_selections_stay_apart() {
        let mut selections = Selections::single(at(0, 0));
        selections.replace_newest(Selection::spanning(at(0, 0), at(0, 3)));
        selections.add(Selection::spanning(at(0, 3), at(0, 6)));
        assert_eq!(selections.count(), 2);
    }

    #[test]
    fn rows_in_view_are_found_by_search() {
        let mut selections = Selections::single(at(0, 0));
        for row in 1..100 {
            selections.add(Selection::cursor(at(row, 0)));
        }
        let visible = selections.in_rows(40, 45);
        assert_eq!(visible.len(), 5);
        assert_eq!(visible[0].head.row, 40);
    }

    #[test]
    fn removing_a_cursor_keeps_the_last_one() {
        let mut selections = Selections::single(at(2, 0));
        selections.add(Selection::cursor(at(4, 0)));
        assert!(selections.remove_cursor_at(at(4, 0)));
        assert!(!selections.remove_cursor_at(at(2, 0)));
        assert_eq!(selections.newest().head, at(2, 0));
    }
}
