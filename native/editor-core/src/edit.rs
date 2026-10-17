//! A change to the text, as character offsets in the text before the change. Every way of
//! editing builds an [`Edits`] and hands it to the buffer, so selections, anchors and undo all
//! learn about a change from one description of it.

use std::ops::Range;

use crate::anchor::Bias;

/// Replaces the characters `start..end` with `text`. An empty range inserts, empty text deletes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl Edit {
    /// An edit that replaces a range of characters with text.
    pub fn replace(range: Range<usize>, text: impl Into<String>) -> Self {
        Edit { start: range.start, end: range.end, text: text.into() }
    }

    /// How many characters the replacement has.
    pub fn inserted_length(&self) -> usize {
        self.text.chars().count()
    }

    /// Whether applying the edit changes nothing.
    pub fn is_noop(&self) -> bool {
        self.start == self.end && self.text.is_empty()
    }
}

/// Edits that are applied together to one text: sorted by position, none overlapping, all
/// described against the text as it is before any of them. Describing them against the same
/// text is what lets several cursors edit at once without any of them using a stale position.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Edits {
    list: Vec<Edit>,
}

impl Edits {
    /// Edits already in order. A range that starts inside the one before it is cut back to
    /// begin where that one ends, so the set never overlaps.
    pub fn new(mut list: Vec<Edit>) -> Self {
        let mut covered_until = 0;
        for edit in &mut list {
            edit.start = edit.start.max(covered_until);
            edit.end = edit.end.max(edit.start);
            covered_until = edit.end;
        }
        Edits { list }
    }

    /// The edits, in order.
    pub fn iter(&self) -> std::slice::Iter<'_, Edit> {
        self.list.iter()
    }

    /// Whether none of the edits changes anything.
    pub fn is_noop(&self) -> bool {
        self.list.iter().all(Edit::is_noop)
    }

    /// Where an offset in the text before the edits is in the text after them. An offset
    /// inside a replaced range, or exactly at an insertion, moves to one side of the new text
    /// as the bias says: `Left` to before it, `Right` to after it.
    pub fn map_offset(&self, offset: usize, bias: Bias) -> usize {
        let mut shift: isize = 0;
        for edit in &self.list {
            if offset < edit.start {
                break;
            }
            let start_after = (edit.start as isize + shift) as usize;
            if offset <= edit.end {
                return match bias {
                    Bias::Left => start_after,
                    Bias::Right => start_after + edit.inserted_length(),
                };
            }
            shift += edit.inserted_length() as isize - (edit.end - edit.start) as isize;
        }
        (offset as isize + shift) as usize
    }

    /// Where each edit's new text sits in the text after the edits, one range per edit.
    pub fn replacement_ranges(&self) -> Vec<Range<usize>> {
        let mut shift: isize = 0;
        let mut ranges = Vec::with_capacity(self.list.len());
        for edit in &self.list {
            let start = (edit.start as isize + shift) as usize;
            ranges.push(start..start + edit.inserted_length());
            shift += edit.inserted_length() as isize - (edit.end - edit.start) as isize;
        }
        ranges
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edits(list: &[(usize, usize, &str)]) -> Edits {
        Edits::new(list.iter().map(|(start, end, text)| Edit::replace(*start..*end, *text)).collect())
    }

    #[test]
    fn offsets_before_and_after_an_edit_shift_by_what_came_before() {
        let edits = edits(&[(2, 4, "xyz")]);
        assert_eq!(edits.map_offset(1, Bias::Left), 1);
        assert_eq!(edits.map_offset(6, Bias::Left), 7);
    }

    #[test]
    fn an_insertion_at_an_offset_goes_to_the_side_of_its_bias() {
        let edits = edits(&[(3, 3, "ab")]);
        assert_eq!(edits.map_offset(3, Bias::Left), 3);
        assert_eq!(edits.map_offset(3, Bias::Right), 5);
    }

    #[test]
    fn offsets_inside_a_deletion_collapse_to_it() {
        let edits = edits(&[(2, 6, "")]);
        assert_eq!(edits.map_offset(4, Bias::Left), 2);
        assert_eq!(edits.map_offset(4, Bias::Right), 2);
        assert_eq!(edits.map_offset(6, Bias::Right), 2);
        assert_eq!(edits.map_offset(7, Bias::Right), 3);
    }

    #[test]
    fn several_edits_all_count_against_the_old_text() {
        let edits = edits(&[(0, 0, "a"), (4, 5, ""), (9, 9, "bb")]);
        assert_eq!(edits.map_offset(4, Bias::Right), 5);
        assert_eq!(edits.map_offset(8, Bias::Left), 8);
        assert_eq!(edits.map_offset(10, Bias::Left), 12);
        assert_eq!(edits.replacement_ranges(), vec![0..1, 5..5, 9..11]);
    }

    #[test]
    fn overlapping_edits_are_cut_back() {
        let edits = edits(&[(0, 5, "a"), (3, 7, "b")]);
        let second: Vec<_> = edits.iter().map(|edit| (edit.start, edit.end)).collect();
        assert_eq!(second, vec![(0, 5), (5, 7)]);
    }
}
