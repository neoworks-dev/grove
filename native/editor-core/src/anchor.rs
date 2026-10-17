//! Anchors: places in the text that keep their meaning while it changes. Decorations such as
//! diagnostics, git blame and inlays are pinned to anchors, so a squiggle stays under its word
//! while text is typed above it, and nothing has to recompute positions after an edit.

use std::collections::HashMap;

use crate::edit::Edits;

/// Which side of text inserted exactly at an anchor the anchor stays on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bias {
    /// The anchor stays before the new text, as the start of a range should.
    Left,
    /// The anchor moves after the new text, as the end of a range or a cursor should.
    Right,
}

/// A character offset in the text and the side it sticks to. Text deleted around an anchor
/// pulls it to where the deletion was; undo does not put it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub offset: usize,
    pub bias: Bias,
}

impl Anchor {
    /// The same anchor after a set of edits.
    pub fn mapped(&self, edits: &Edits) -> Anchor {
        Anchor { offset: edits.map_offset(self.offset, self.bias), bias: self.bias }
    }
}

/// Names an anchor held by the editor, which keeps it up to date through every edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AnchorId(u64);

/// The anchors the editor keeps up to date: whoever pins something to the text asks for one
/// and later asks where it is.
#[derive(Debug, Default)]
pub struct Anchors {
    anchors: HashMap<AnchorId, Anchor>,
    next_id: u64,
}

impl Anchors {
    /// Starts tracking an anchor.
    pub fn insert(&mut self, anchor: Anchor) -> AnchorId {
        let id = AnchorId(self.next_id);
        self.next_id += 1;
        self.anchors.insert(id, anchor);
        id
    }

    /// Where an anchor is now, or none after it was removed.
    pub fn get(&self, id: AnchorId) -> Option<Anchor> {
        self.anchors.get(&id).copied()
    }

    /// Stops tracking an anchor.
    pub fn remove(&mut self, id: AnchorId) {
        self.anchors.remove(&id);
    }

    /// How many anchors are tracked.
    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    /// Whether no anchor is tracked.
    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }

    /// Moves every anchor through a set of edits.
    pub fn apply_edits(&mut self, edits: &Edits) {
        for anchor in self.anchors.values_mut() {
            *anchor = anchor.mapped(edits);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::Edit;

    #[test]
    fn anchors_follow_edits_before_them() {
        let mut anchors = Anchors::default();
        let id = anchors.insert(Anchor { offset: 10, bias: Bias::Left });
        anchors.apply_edits(&Edits::new(vec![Edit::replace(0..0, "abc")]));
        assert_eq!(anchors.get(id).unwrap().offset, 13);
        anchors.apply_edits(&Edits::new(vec![Edit::replace(2..6, "")]));
        assert_eq!(anchors.get(id).unwrap().offset, 9);
    }

    #[test]
    fn bias_decides_which_side_of_an_insertion_at_the_anchor() {
        let mut anchors = Anchors::default();
        let left = anchors.insert(Anchor { offset: 4, bias: Bias::Left });
        let right = anchors.insert(Anchor { offset: 4, bias: Bias::Right });
        anchors.apply_edits(&Edits::new(vec![Edit::replace(4..4, "xx")]));
        assert_eq!(anchors.get(left).unwrap().offset, 4);
        assert_eq!(anchors.get(right).unwrap().offset, 6);
    }

    #[test]
    fn removed_anchors_are_gone() {
        let mut anchors = Anchors::default();
        let id = anchors.insert(Anchor { offset: 0, bias: Bias::Left });
        anchors.remove(id);
        assert_eq!(anchors.get(id), None);
    }
}
