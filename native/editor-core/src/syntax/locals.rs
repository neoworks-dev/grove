//! Local names: a grammar's `locals` query marks scopes, the names defined in them and the places
//! that use those names, and a use is coloured as the definition it resolves to. Grammars that
//! bring one are the WebAssembly ones, as the compiled-in ones colour by position alone.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

use ropey::Rope;
use tree_sitter::{QueryCursor, StreamingIterator};

use super::highlight::HighlightId;
use super::{Layer, RopeText};

/// A use of a local name, with the definition it resolves to.
pub struct LocalReference {
    pub range: Range<usize>,
    pub definition: Range<usize>,
}

/// The references found in a layer, kept while the layer's text and position stay as they were.
#[derive(Default)]
pub struct LocalsCache {
    found: Mutex<Option<(Range<usize>, Arc<Vec<LocalReference>>)>>,
}

impl LocalsCache {
    /// Forgets what was found, for a layer whose tree changed.
    pub fn reset(&self) {
        *self.found.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// The layer's references, found by `find` when there are none kept for the range the layer covers.
    fn references(&self, range: &Range<usize>, find: impl FnOnce() -> Vec<LocalReference>) -> Arc<Vec<LocalReference>> {
        let mut found = self.found.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((kept_range, references)) = found.as_ref() {
            if kept_range == range {
                return references.clone();
            }
        }
        let references = Arc::new(find());
        *found = Some((range.clone(), references.clone()));
        references
    }
}

/// What a capture of the locals query stands for.
enum Role {
    Scope,
    Definition,
    Reference,
}

/// The role of each capture index of the locals query, none for captures that mean nothing here.
fn roles_of(names: &[&str]) -> Vec<Option<Role>> {
    names
        .iter()
        .map(|name| {
            if *name == "local.scope" {
                Some(Role::Scope)
            } else if *name == "local.definition" || name.starts_with("local.definition.") {
                Some(Role::Definition)
            } else if *name == "local.reference" {
                Some(Role::Reference)
            } else {
                None
            }
        })
        .collect()
}

/// A scope still open while the tree is walked: where it ends and the names defined in it so far.
struct OpenScope {
    end: usize,
    definitions: HashMap<String, Range<usize>>,
}

/// Resolves every use of a local name in a layer to its definition, walking the captures in order
/// of position, so a name is only known to the uses after its definition and inside its scope.
fn find_references(layer: &Layer, rope: &Rope) -> Vec<LocalReference> {
    let Some(query) = layer.language.locals_query() else {
        return Vec::new();
    };
    let roles = roles_of(query.capture_names());
    let mut scopes = vec![OpenScope { end: usize::MAX, definitions: HashMap::new() }];
    let mut references = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(query, layer.tree.root_node(), RopeText(rope));
    while let Some((query_match, capture_index)) = captures.next() {
        let capture = query_match.captures[*capture_index];
        let Some(role) = &roles[capture.index as usize] else {
            continue;
        };
        let range = capture.node.byte_range();
        while scopes.len() > 1 && scopes.last().is_some_and(|scope| scope.end <= range.start) {
            scopes.pop();
        }
        match role {
            Role::Scope => scopes.push(OpenScope { end: range.end, definitions: HashMap::new() }),
            Role::Definition => define(&mut scopes, rope, range),
            Role::Reference => resolve(&scopes, rope, range, &mut references),
        }
    }
    references
}

/// Records a name as defined in the innermost open scope.
fn define(scopes: &mut [OpenScope], rope: &Rope, range: Range<usize>) {
    let name = rope.byte_slice(range.clone()).to_string();
    if let Some(scope) = scopes.last_mut() {
        scope.definitions.insert(name, range);
    }
}

/// Adds a use of a name to `references` when an open scope, the innermost first, has defined it.
fn resolve(scopes: &[OpenScope], rope: &Rope, range: Range<usize>, references: &mut Vec<LocalReference>) {
    let name = rope.byte_slice(range.clone()).to_string();
    let defined = scopes.iter().rev().find_map(|scope| scope.definitions.get(&name));
    let Some(definition) = defined else {
        return;
    };
    // A name that is both defined and used by the same node resolves to itself, which says nothing.
    if *definition != range {
        references.push(LocalReference { range, definition: definition.clone() });
    }
}

/// Adds captures that colour the uses of local names in a layer, within `bytes`, as their
/// definitions are coloured. Captures are added after the layer's own, so they win over them.
pub fn collect_local_captures(
    layer: &Layer,
    rope: &Rope,
    bytes: &Range<usize>,
    out: &mut Vec<(Range<usize>, Option<HighlightId>)>,
) {
    if layer.language.locals_query().is_none() {
        return;
    }
    let references = layer.locals.references(&layer.range, || find_references(layer, rope));
    let start = references.partition_point(|reference| reference.range.end <= bytes.start);
    for reference in references[start..].iter().take_while(|reference| reference.range.start < bytes.end) {
        if let Some(id) = definition_highlight(layer, rope, &reference.definition) {
            out.push((reference.range.clone(), Some(id)));
        }
    }
}

/// The highlight the layer's own query gives the text of a definition, if it gives it one.
fn definition_highlight(layer: &Layer, rope: &Rope, definition: &Range<usize>) -> Option<HighlightId> {
    let compiled = layer.language.highlight_query()?;
    let mut cursor = QueryCursor::new();
    cursor.set_byte_range(definition.clone());
    let mut captures = cursor.captures(&compiled.query, layer.tree.root_node(), RopeText(rope));
    let mut found = None;
    while let Some((query_match, capture_index)) = captures.next() {
        let capture = query_match.captures[*capture_index];
        if capture.node.byte_range() != *definition {
            continue;
        }
        if let Some(id) = compiled.highlights[capture.index as usize] {
            found = Some(id);
        }
    }
    found
}
