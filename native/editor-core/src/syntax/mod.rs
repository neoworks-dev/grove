//! Syntax trees for the text being edited: a tree-sitter parse of the whole file, trees for the
//! other languages embedded in it, and the highlights read from them.
//!
//! The trees follow the text. The buffer records every change it makes in bytes, the trees are
//! told about each one, and the parser then reuses what the change left alone, so typing in a
//! large file reparses a little rather than all of it. Highlights are only read for the rows a
//! view asks for.

mod external;
mod gitignore;
mod highlight;
mod injections;
mod languages;
mod locals;
mod scopes;
mod wasm;

use std::ops::Range;

use ropey::Rope;
use tree_sitter::{InputEdit, Node, Point, QueryCursor, StreamingIterator, TextProvider, Tree};

use crate::buffer::{Buffer, BytePoint, TextChange};
use injections::{Injection, StaleLayer};
use wasm::LayerParser;

pub use external::{GrammarSpec, RejectedGrammar, generation as grammar_generation, set_grammars};
pub use highlight::{HIGHLIGHT_NAMES, HighlightId, HighlightSpan, flatten_captures, highlight_for_capture};
pub use languages::{LanguageDefinition, all_languages, language_for_name, language_for_path, language_for_shebang};
pub use scopes::Scope;

/// One parse: the whole file in its own language, or the stretch of it that is code in another.
struct Layer {
    language: &'static LanguageDefinition,
    tree: Tree,
    /// The bytes of the text the layer is parsed from.
    range: Range<usize>,
    /// What the grammar's locals query found, for the grammars that have one.
    locals: locals::LocalsCache,
}

/// The syntax of one buffer.
pub struct Syntax {
    parser: LayerParser,
    /// The grammar generation the file's language was picked in; extensions that bring grammars later change it.
    generation: u64,
    /// The file's own language, or none when it is not recognised.
    root: Option<Layer>,
    /// Code of other languages inside the file, in order of position and never overlapping.
    injected: Vec<Layer>,
}

impl Syntax {
    /// Parses a buffer in the language its file name says, or builds a syntax with nothing in
    /// it when the language is not known. Changes the buffer already holds are folded in.
    pub fn new(buffer: &mut Buffer) -> Self {
        buffer.take_changes();
        let mut syntax =
            Syntax { parser: LayerParser::new(), generation: grammar_generation(), root: None, injected: Vec::new() };
        let Some(language) = language_of(buffer) else {
            return syntax;
        };
        let Some(tree) = parse(&mut syntax.parser, language, buffer.rope(), &[], None) else {
            return syntax;
        };
        syntax.root =
            Some(Layer { language, tree, range: 0..buffer.rope().len_bytes(), locals: locals::LocalsCache::default() });
        syntax.injected = syntax.find_injected_layers(buffer.rope(), Vec::new());
        syntax
    }

    /// The name of the language the file is highlighted as, if it is one.
    pub fn language_name(&self) -> Option<&'static str> {
        self.root.as_ref().map(|layer| layer.language.name)
    }

    /// Whether the grammars handed over since this syntax was made change which language the file is in.
    pub fn language_may_have_changed(&self, buffer: &Buffer) -> bool {
        if self.generation == grammar_generation() {
            return false;
        }
        let current = language_of(buffer).map(|language| language as *const LanguageDefinition);
        let held = self.root.as_ref().map(|layer| layer.language as *const LanguageDefinition);
        current != held
    }

    /// Brings the trees up to date with the changes the buffer has made since they last were.
    pub fn update(&mut self, buffer: &mut Buffer) {
        let changes = buffer.take_changes();
        let Some(root) = &mut self.root else {
            return;
        };
        if changes.is_empty() {
            return;
        }
        for change in &changes {
            root.tree.edit(&input_edit(change));
        }
        if let Some(tree) = parse(&mut self.parser, root.language, buffer.rope(), &[], Some(&root.tree)) {
            root.tree = tree;
            root.locals.reset();
        }
        root.range = 0..buffer.rope().len_bytes();
        let stale = injections::age_layers(std::mem::take(&mut self.injected), &changes);
        self.injected = self.find_injected_layers(buffer.rope(), stale);
    }

    /// The highlight runs of each row in `rows`, as columns of that row. Rows past the end of the
    /// text come back empty.
    pub fn highlights(&self, buffer: &Buffer, rows: Range<usize>) -> Vec<Vec<HighlightSpan>> {
        let rope = buffer.rope();
        let row_count = rows.end.saturating_sub(rows.start);
        let Some(root) = &self.root else {
            return vec![Vec::new(); row_count];
        };
        let first_row = rows.start.min(rope.len_lines());
        let end_row = rows.end.min(rope.len_lines());
        let bytes = rope.line_to_byte(first_row)..rope.line_to_byte(end_row);

        let mut captures = Vec::new();
        collect_captures(root, rope, &bytes, &mut captures);
        for layer in injections::layers_in(&self.injected, &bytes) {
            // The outer language's colour for the embedded text gives way to the layer's own.
            if !layer.language.overlay {
                captures.push((layer.range.clone(), None));
            }
            collect_captures(layer, rope, &bytes, &mut captures);
        }
        captures.sort_by_key(|(range, _)| range.start);
        let runs = flatten_captures(&captures);

        let mut per_row = split_into_rows(rope, &runs, first_row..end_row);
        per_row.resize(row_count, Vec::new());
        per_row
    }

    /// Finds the code of other languages in the file and parses each, reusing the old parse of
    /// a layer that the changes left alone or only edited.
    fn find_injected_layers(&mut self, rope: &Rope, stale: Vec<StaleLayer>) -> Vec<Layer> {
        let Some(root) = &self.root else {
            return Vec::new();
        };
        let found = injections::find(root.language, &root.tree, rope);
        let mut reuse = injections::Reuse::new(stale);
        let mut layers = Vec::with_capacity(found.len());
        for Injection { language, range } in found {
            if let Some(layer) = reuse.exact(language, &range) {
                layers.push(layer);
                continue;
            }
            let previous = reuse.overlapping(language, &range);
            let ranges = [tree_range(rope, &range)];
            let old_tree = previous.as_ref().map(|layer| &layer.tree);
            let Some(tree) = parse(&mut self.parser, language, rope, &ranges, old_tree) else {
                continue;
            };
            layers.push(Layer { language, tree, range, locals: locals::LocalsCache::default() });
        }
        layers
    }
}

/// The language of a buffer: the one its file name says, or else the one a `#!` line on the first
/// row names.
fn language_of(buffer: &Buffer) -> Option<&'static LanguageDefinition> {
    if let Some(language) = buffer.path().and_then(language_for_path) {
        return Some(language);
    }
    language_for_shebang(&buffer.line(0))
}

/// Parses the text, or the `ranges` of it when there are any, reusing `old_tree` once it has
/// been told of the changes since.
fn parse(
    parser: &mut LayerParser,
    language: &LanguageDefinition,
    rope: &Rope,
    ranges: &[tree_sitter::Range],
    old_tree: Option<&Tree>,
) -> Option<Tree> {
    // Compiling the language's queries takes long enough to be felt, so it happens here, when
    // the file is opened, and not when its first rows are painted.
    language.highlight_query();
    let parser = parser.prepared_for(&language.grammar()).ok()?;
    parser.set_included_ranges(ranges).ok()?;
    let mut read = |byte: usize, _: Point| chunk_from(rope, byte);
    parser.parse_with_options(&mut read, old_tree, None)
}

/// The text from a byte on, up to the end of the rope chunk it is in, which is how the parser reads.
fn chunk_from(rope: &Rope, byte: usize) -> &[u8] {
    if byte >= rope.len_bytes() {
        return &[];
    }
    let (chunk, chunk_start, _, _) = rope.chunk_at_byte(byte);
    &chunk.as_bytes()[byte - chunk_start..]
}

/// The range of the text a layer is parsed from, in the terms the parser uses.
fn tree_range(rope: &Rope, range: &Range<usize>) -> tree_sitter::Range {
    tree_sitter::Range {
        start_byte: range.start,
        end_byte: range.end,
        start_point: point_of(rope, range.start),
        end_point: point_of(rope, range.end),
    }
}

/// The line and byte within it of a byte offset, as the parser counts.
fn point_of(rope: &Rope, byte: usize) -> Point {
    let row = rope.byte_to_line(byte);
    Point { row, column: byte - rope.line_to_byte(row) }
}

/// A buffer change as the edit a tree is told about.
fn input_edit(change: &TextChange) -> InputEdit {
    InputEdit {
        start_byte: change.start_byte,
        old_end_byte: change.old_end_byte,
        new_end_byte: change.new_end_byte,
        start_position: point(change.start_point),
        old_end_position: point(change.old_end_point),
        new_end_position: point(change.new_end_point),
    }
}

/// A buffer point as the parser's.
fn point(point: BytePoint) -> Point {
    Point { row: point.row, column: point.column }
}

/// Reads the highlight captures of a layer that touch a byte range, in order of position.
fn collect_captures(
    layer: &Layer,
    rope: &Rope,
    bytes: &Range<usize>,
    out: &mut Vec<(Range<usize>, Option<HighlightId>)>,
) {
    let Some(compiled) = layer.language.highlight_query() else {
        return;
    };
    let mut cursor = QueryCursor::new();
    cursor.set_byte_range(bytes.clone());
    let mut captures = cursor.captures(&compiled.query, layer.tree.root_node(), RopeText(rope));
    while let Some((query_match, capture_index)) = captures.next() {
        let capture = query_match.captures[*capture_index];
        let Some(id) = compiled.highlights[capture.index as usize] else {
            continue;
        };
        out.push((capture.node.byte_range(), Some(id)));
    }
    drop(captures);
    locals::collect_local_captures(layer, rope, bytes, out);
}

/// Gives a query the text of a node, for predicates such as `#eq?` and `#match?`, straight
/// from the rope's chunks.
pub(crate) struct RopeText<'rope>(pub &'rope Rope);

impl<'rope> TextProvider<&'rope [u8]> for RopeText<'rope> {
    type I = RopeChunks<'rope>;

    /// The text of a node, one rope chunk at a time.
    fn text(&mut self, node: Node) -> RopeChunks<'rope> {
        RopeChunks { chunks: self.0.byte_slice(node.byte_range()).chunks() }
    }
}

/// The text of a node, one rope chunk at a time, as bytes.
pub(crate) struct RopeChunks<'rope> {
    chunks: ropey::iter::Chunks<'rope>,
}

impl<'rope> Iterator for RopeChunks<'rope> {
    type Item = &'rope [u8];

    /// The next chunk of the node's text.
    fn next(&mut self) -> Option<&'rope [u8]> {
        self.chunks.next().map(str::as_bytes)
    }
}

/// Cuts runs of text into the rows they cover, with columns counted in characters.
fn split_into_rows(rope: &Rope, runs: &[(Range<usize>, HighlightId)], rows: Range<usize>) -> Vec<Vec<HighlightSpan>> {
    let mut per_row = Vec::with_capacity(rows.len());
    let mut first_run = 0;
    for row in rows {
        let row_start = rope.line_to_byte(row);
        let row_end = row_start + line_content_length(rope, row);
        first_run += runs[first_run..].partition_point(|(range, _)| range.end <= row_start);
        let line_start_char = rope.line_to_char(row);
        let mut spans = Vec::new();
        for (range, id) in &runs[first_run..] {
            if range.start >= row_end {
                break;
            }
            let start = range.start.max(row_start);
            let end = range.end.min(row_end);
            if start >= end {
                continue;
            }
            let start_column = rope.byte_to_char(start) - line_start_char;
            let end_column = rope.byte_to_char(end) - line_start_char;
            spans.push(HighlightSpan { start_column, end_column, id: *id });
        }
        per_row.push(spans);
    }
    per_row
}

/// How many bytes a row has, without its line ending.
fn line_content_length(rope: &Rope, row: usize) -> usize {
    let line = rope.line(row);
    let mut length = line.len_bytes();
    if length > 0 && line.byte(length - 1) == b'\n' {
        length -= 1;
    }
    length
}
