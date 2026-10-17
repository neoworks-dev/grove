//! Code of one language inside another, such as the script of a Svelte file or a fenced block in
//! markdown. Each piece is parsed as a layer of its own, and a layer that an edit did not touch
//! is carried over instead of being parsed again.

use std::collections::BTreeMap;
use std::ops::Range;

use ropey::Rope;
use tree_sitter::{QueryCursor, StreamingIterator, Tree};

use super::languages::{LanguageDefinition, language_for_name};
use super::{Layer, RopeText, input_edit};
use crate::buffer::TextChange;

/// A stretch of the text that is code in another language.
pub struct Injection {
    pub language: &'static LanguageDefinition,
    pub range: Range<usize>,
}

/// A layer from before a change, moved to where the change put its text.
pub struct StaleLayer {
    layer: Layer,
    /// Whether a change reached into the layer's text, so it must be parsed again.
    touched: bool,
}

/// Finds the stretches of text that the language's injection query says are other languages.
/// Where several patterns pick out the same text, the one written last wins. Languages that are
/// not compiled in are skipped.
pub fn find(language: &LanguageDefinition, tree: &Tree, rope: &Rope) -> Vec<Injection> {
    let Some(query) = language.injection_query() else {
        return Vec::new();
    };
    let Some(content_index) = query.capture_index_for_name("injection.content") else {
        return Vec::new();
    };
    let language_index = query.capture_index_for_name("injection.language");

    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, tree.root_node(), RopeText(rope));
    let mut by_range: BTreeMap<(usize, usize), (usize, &'static LanguageDefinition)> = BTreeMap::new();
    while let Some(query_match) = matches.next() {
        let Some(content) = query_match.captures.iter().find(|capture| capture.index == content_index) else {
            continue;
        };
        let range = content.node.byte_range();
        if range.is_empty() {
            continue;
        }
        let mut name = None;
        if let Some(index) = language_index {
            let named = query_match.captures.iter().find(|capture| capture.index == index);
            name = named.map(|capture| rope.byte_slice(capture.node.byte_range()).to_string());
        }
        for property in query.property_settings(query_match.pattern_index) {
            if &*property.key == "injection.language" {
                name = property.value.as_ref().map(|value| value.to_string());
            }
        }
        let Some(injected) = name.as_deref().and_then(language_for_name) else {
            continue;
        };
        let newer =
            by_range.get(&(range.start, range.end)).is_none_or(|(pattern, _)| query_match.pattern_index >= *pattern);
        if newer {
            by_range.insert((range.start, range.end), (query_match.pattern_index, injected));
        }
    }
    drop_nested(by_range.into_iter().map(|((start, end), (_, language))| Injection { language, range: start..end }))
}

/// Keeps the injections that are not inside an earlier one, so layers never overlap.
fn drop_nested(injections: impl Iterator<Item = Injection>) -> Vec<Injection> {
    let mut kept: Vec<Injection> = Vec::new();
    for injection in injections {
        let inside_previous = kept.last().is_some_and(|previous| injection.range.start < previous.range.end);
        if !inside_previous {
            kept.push(injection);
        }
    }
    kept
}

/// Tells each layer's tree about the changes, and works out where its text is now and whether
/// any change reached into it.
pub fn age_layers(layers: Vec<Layer>, changes: &[TextChange]) -> Vec<StaleLayer> {
    let mut aged = Vec::with_capacity(layers.len());
    for mut layer in layers {
        let mut touched = false;
        for change in changes {
            layer.tree.edit(&input_edit(change));
            let reaches_in = change.start_byte < layer.range.end && change.old_end_byte > layer.range.start;
            touched = touched || reaches_in;
            layer.range = move_range_through(&layer.range, change);
        }
        aged.push(StaleLayer { layer, touched });
    }
    aged
}

/// Where a range of text is after a change. Text inserted at its start stays before it and text
/// inserted at its end stays after it.
fn move_range_through(range: &Range<usize>, change: &TextChange) -> Range<usize> {
    let delta = change.new_end_byte as isize - change.old_end_byte as isize;
    let start = if range.start >= change.old_end_byte {
        (range.start as isize + delta) as usize
    } else if range.start <= change.start_byte {
        range.start
    } else {
        change.start_byte
    };
    let end = if range.end <= change.start_byte {
        range.end
    } else if range.end >= change.old_end_byte {
        (range.end as isize + delta) as usize
    } else {
        change.new_end_byte
    };
    start..end.max(start)
}

/// The layers that lie in a byte range.
pub fn layers_in<'layers>(layers: &'layers [Layer], bytes: &Range<usize>) -> impl Iterator<Item = &'layers Layer> {
    let first = layers.partition_point(|layer| layer.range.end <= bytes.start);
    let end = bytes.end;
    layers[first..].iter().take_while(move |layer| layer.range.start < end)
}

/// Old layers waiting to be matched with the injections found now. Both are in order of
/// position, so matching walks forward through the old ones.
pub struct Reuse {
    layers: Vec<Option<StaleLayer>>,
    /// The first old layer that may still lie at or after the injection being matched.
    next: usize,
}

impl Reuse {
    /// The old layers, in order of position.
    pub fn new(layers: Vec<StaleLayer>) -> Self {
        Reuse { layers: layers.into_iter().map(Some).collect(), next: 0 }
    }

    /// The old layer that is the same language over the same text and was not touched, whose
    /// tree is still right as it is.
    pub fn exact(&mut self, language: &'static LanguageDefinition, range: &Range<usize>) -> Option<Layer> {
        for index in self.candidates(range) {
            let Some(stale) = &self.layers[index] else {
                continue;
            };
            let same = std::ptr::eq(stale.layer.language, language) && stale.layer.range == *range;
            if same && !stale.touched {
                return self.layers[index].take().map(|stale| stale.layer);
            }
        }
        None
    }

    /// An old layer of the same language that lay where the injection is now, to parse from.
    pub fn overlapping(&mut self, language: &'static LanguageDefinition, range: &Range<usize>) -> Option<Layer> {
        for index in self.candidates(range) {
            let Some(stale) = &self.layers[index] else {
                continue;
            };
            if std::ptr::eq(stale.layer.language, language) {
                return self.layers[index].take().map(|stale| stale.layer);
            }
        }
        None
    }

    /// The indices of the old layers that overlap a range, skipping past the ones before it for good.
    fn candidates(&mut self, range: &Range<usize>) -> Range<usize> {
        while self.next < self.layers.len() && self.end_of(self.next) <= range.start {
            self.next += 1;
        }
        let mut end = self.next;
        while end < self.layers.len() && self.start_of(end) < range.end {
            end += 1;
        }
        self.next..end
    }

    /// Where the old layer at an index ends, whether or not it has been taken.
    fn end_of(&self, index: usize) -> usize {
        match &self.layers[index] {
            Some(stale) => stale.layer.range.end,
            None => 0,
        }
    }

    /// Where the old layer at an index starts, whether or not it has been taken.
    fn start_of(&self, index: usize) -> usize {
        match &self.layers[index] {
            Some(stale) => stale.layer.range.start,
            None => 0,
        }
    }
}
