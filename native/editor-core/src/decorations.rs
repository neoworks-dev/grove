//! Decorations: things drawn on top of the text that the text does not own. Errors, type hints,
//! git blame, diff colours and review comments are all decorations. A source (a language server,
//! git, an agent) owns a named set and replaces it whole, so none of them touches another's.
//!
//! Every decoration is pinned to anchors, so it follows the text it was put on through edits and
//! nothing has to recompute positions after typing. The editor's display map lays them out: inlays
//! widen a line, blocks add rows between lines, and the rest only paint.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::anchor::{Anchor, AnchorId, Anchors, Bias};
use crate::buffer::{Buffer, Position};

/// What a decoration means, which the theme turns into a colour so a source never picks one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Error,
    Warning,
    Info,
    Hint,
    Added,
    Modified,
    Deleted,
    /// Text an inlay adds in the middle of a line.
    Inlay,
    /// Text added after the end of a line.
    LineEnd,
    /// Another place the word under the cursor appears, drawn as a quiet background.
    Occurrence,
    /// Words that were added inside a changed line, drawn stronger than the line's own tint.
    AddedWord,
    /// Words that were removed from a changed line.
    DeletedWord,
    /// Rows that stand in for lines the other side of a comparison has, so the two line up.
    Filler,
    /// A place the last search found in vim.
    SearchMatch,
}

/// How a line under a highlighted range is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnderlineKind {
    Squiggle,
    Line,
}

/// A line under a highlighted range, in the colour of a tone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Underline {
    pub style: UnderlineKind,
    pub tone: Tone,
}

/// What a decoration puts beside the line numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GutterMark {
    /// A vertical bar along every row of the range, such as a changed hunk.
    Bar,
    /// A round dot on the first row, such as a breakpoint or an error.
    Dot,
    /// A small notch at the top of the first row, for lines that were deleted above it.
    Notch,
    /// One character on the first row.
    Glyph(char),
}

/// Whether a block goes above or below the line it is pinned to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    Above,
    #[default]
    Below,
}

/// What a decoration is. The JSON form has a `kind` naming the variant, such as
/// `{"kind": "inlay", "text": ": i32"}`; a missing `tone` takes the kind's usual one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecorationKind {
    /// Colours the text of a range: a background, a line under it, or both.
    Highlight { background: Option<Tone>, underline: Option<Underline> },
    /// Text drawn at a place in a line, pushing the text after it aside.
    Inlay { text: String, tone: Option<Tone> },
    /// Text drawn after the end of the line the decoration starts on.
    LineEnd { text: String, tone: Option<Tone> },
    /// A mark beside the line numbers, on the rows of the range.
    Gutter { mark: GutterMark, tone: Option<Tone> },
    /// Whole rows of text between two lines of the buffer, such as a deleted hunk.
    Block {
        lines: Vec<String>,
        #[serde(default)]
        placement: Placement,
        tone: Option<Tone>,
        /// Stretches of the block's lines drawn stronger, such as the words a hunk changed.
        #[serde(default)]
        emphasis: Vec<BlockEmphasis>,
        /// A name the app can find the block by: the editor reports where keyed blocks are drawn,
        /// so the app can put its own widget over their rows.
        #[serde(default)]
        key: Option<String>,
    },
    /// Tints the whole width of every row from `start` to `end`, such as the lines of a hunk.
    Line { tone: Tone },
}

/// A stretch of one line of a block, in characters of that line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockEmphasis {
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

/// One decoration as a source sends it: where it is, and what it is. Point kinds (inlays,
/// line-end text, blocks) use `start` only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decoration {
    pub start: Position,
    #[serde(default)]
    pub end: Option<Position>,
    /// What the decoration says when the pointer rests on it, such as a diagnostic's message.
    /// Markdown.
    #[serde(default)]
    pub tooltip: Option<String>,
    #[serde(flatten)]
    pub kind: DecorationKind,
}

/// A decoration as the store holds it, pinned to anchors.
struct Pinned {
    start: AnchorId,
    end: AnchorId,
    kind: DecorationKind,
    tooltip: Option<String>,
}

/// A decoration with its anchors turned into positions as the text is now.
#[derive(Clone, Copy, Debug)]
pub struct Placed<'a> {
    pub start: Position,
    pub end: Position,
    pub kind: &'a DecorationKind,
    pub tooltip: Option<&'a str>,
}

/// A block in the place it is laid out: after which rows it is, what it says and how it is coloured.
#[derive(Clone, Copy, Debug)]
pub struct PlacedBlock<'a> {
    /// The buffer row the block goes before, which is the line count for a block at the very end.
    pub slot: usize,
    /// The buffer row the block is pinned to.
    pub row: usize,
    pub placement: Placement,
    pub lines: &'a [String],
    pub tone: Option<Tone>,
    pub emphasis: &'a [BlockEmphasis],
    pub key: Option<&'a str>,
}

/// The prefix of a source that belongs to one view: `view:<view id>:<name>`. Only the view with
/// that id shows it, so a diff's marks stay in the diff view and not in another view of the file.
pub const VIEW_SOURCE_PREFIX: &str = "view:";

/// Which sources a view shows. Sources that belong to no view are shown unless the view hides
/// them by name; a source that belongs to a view is shown only by that view.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceFilter {
    /// The id the view gives itself, or empty for a view that owns no source.
    pub view: String,
    /// Sources of the document this view does not draw, such as the git bars in a diff view.
    pub hidden: Vec<String>,
}

impl SourceFilter {
    /// Whether the view draws what a source put on the document.
    pub fn shows(&self, source: &str) -> bool {
        let Some(owned) = source.strip_prefix(VIEW_SOURCE_PREFIX) else {
            return !self.hidden.iter().any(|hidden| hidden == source);
        };
        if self.view.is_empty() {
            return false;
        }
        owned.strip_prefix(self.view.as_str()).is_some_and(|rest| rest.starts_with(':'))
    }
}

/// Every source's decorations for one document.
#[derive(Default)]
pub struct Decorations {
    sets: BTreeMap<String, Vec<Pinned>>,
}

impl Decorations {
    /// Replaces everything a source had with `decorations`. An empty list removes the source.
    /// Other sources are not touched.
    pub fn replace(&mut self, source: &str, decorations: &[Decoration], buffer: &Buffer, anchors: &mut Anchors) {
        if let Some(old) = self.sets.remove(source) {
            for pinned in old {
                anchors.remove(pinned.start);
                anchors.remove(pinned.end);
            }
        }
        if decorations.is_empty() {
            return;
        }
        let pinned = decorations.iter().map(|decoration| pin(decoration, buffer, anchors)).collect();
        self.sets.insert(source.to_string(), pinned);
    }

    /// The names of the sources that have decorations.
    pub fn sources(&self) -> Vec<&str> {
        self.sets.keys().map(String::as_str).collect()
    }

    /// How many decorations a source has.
    pub fn count(&self, source: &str) -> usize {
        self.sets.get(source).map_or(0, Vec::len)
    }

    /// Every decoration, as it is placed now, in the order of the sources and then of the source's list.
    pub fn placed<'a>(&'a self, buffer: &Buffer, anchors: &Anchors) -> Vec<Placed<'a>> {
        self.placed_for(buffer, anchors, &SourceFilter::default())
    }

    /// Like `placed`, with only the sources a view shows.
    pub fn placed_for<'a>(&'a self, buffer: &Buffer, anchors: &Anchors, filter: &SourceFilter) -> Vec<Placed<'a>> {
        let shown = self.sets.iter().filter(|(source, _)| filter.shows(source));
        shown.flat_map(|(_, pinned)| pinned).filter_map(|pinned| place(pinned, buffer, anchors)).collect()
    }

    /// The decorations that touch any of `rows`: a range counts when it covers one, a point when
    /// it is on one.
    pub fn placed_in_rows<'a>(
        &'a self,
        rows: std::ops::Range<usize>,
        buffer: &Buffer,
        anchors: &Anchors,
        filter: &SourceFilter,
    ) -> Vec<Placed<'a>> {
        let touches = |placed: &Placed| placed.end.row >= rows.start && placed.start.row < rows.end;
        self.placed_for(buffer, anchors, filter).into_iter().filter(touches).collect()
    }

    /// The blocks, in the order they are laid out: by the row they go before, and where several
    /// go in one place, in the order they came.
    pub fn blocks<'a>(&'a self, buffer: &Buffer, anchors: &Anchors, filter: &SourceFilter) -> Vec<PlacedBlock<'a>> {
        let line_count = buffer.line_count();
        let mut blocks: Vec<PlacedBlock> = self
            .placed_for(buffer, anchors, filter)
            .into_iter()
            .filter_map(|placed| {
                let DecorationKind::Block { lines, placement, tone, emphasis, key } = placed.kind else {
                    return None;
                };
                let row = placed.start.row;
                let slot = match placement {
                    Placement::Above => row,
                    Placement::Below => row + 1,
                };
                Some(PlacedBlock {
                    slot: slot.min(line_count),
                    row,
                    placement: *placement,
                    lines,
                    tone: *tone,
                    emphasis,
                    key: key.as_deref(),
                })
            })
            .collect();
        blocks.sort_by_key(|block| block.slot);
        blocks
    }
}

/// Pins a decoration to the text with anchors that suit its kind: a highlight does not grow
/// when text is typed at its edges, a gutter range does, an inlay stays after what is typed at
/// it, and the rest stay put.
fn pin(decoration: &Decoration, buffer: &Buffer, anchors: &mut Anchors) -> Pinned {
    let start_offset = buffer.offset_of(decoration.start);
    let end_offset = match decoration.end {
        Some(end) => buffer.offset_of(end).max(start_offset),
        None => start_offset,
    };
    let (start_bias, end_bias) = match decoration.kind {
        DecorationKind::Highlight { .. } => (Bias::Right, Bias::Left),
        DecorationKind::Gutter { .. } => (Bias::Left, Bias::Right),
        DecorationKind::Inlay { .. } => (Bias::Right, Bias::Right),
        DecorationKind::LineEnd { .. } | DecorationKind::Block { .. } => (Bias::Left, Bias::Left),
        DecorationKind::Line { .. } => (Bias::Left, Bias::Right),
    };
    Pinned {
        start: anchors.insert(Anchor { offset: start_offset, bias: start_bias }),
        end: anchors.insert(Anchor { offset: end_offset, bias: end_bias }),
        kind: decoration.kind.clone(),
        tooltip: decoration.tooltip.clone(),
    }
}

/// Where a decoration is now. A range whose ends crossed because the text between them went
/// away collapses to a point.
fn place<'a>(pinned: &'a Pinned, buffer: &Buffer, anchors: &Anchors) -> Option<Placed<'a>> {
    let start = anchors.get(pinned.start)?.offset;
    let end = anchors.get(pinned.end)?.offset.max(start);
    Some(Placed {
        start: buffer.position_of(start),
        end: buffer.position_of(end),
        kind: &pinned.kind,
        tooltip: pinned.tooltip.as_deref(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Command;
    use crate::state::EditorState;

    fn at(row: usize, column: usize) -> Position {
        Position { row, column }
    }

    fn squiggle(start: Position, end: Position) -> Decoration {
        let underline = Underline { style: UnderlineKind::Squiggle, tone: Tone::Error };
        Decoration {
            start,
            end: Some(end),
            tooltip: None,
            kind: DecorationKind::Highlight { background: None, underline: Some(underline) },
        }
    }

    fn inlay(at: Position, text: &str) -> Decoration {
        Decoration {
            start: at,
            end: None,
            tooltip: None,
            kind: DecorationKind::Inlay { text: text.into(), tone: None },
        }
    }

    fn line_end(row: usize, text: &str) -> Decoration {
        Decoration {
            start: at(row, 1_000_000),
            end: None,
            tooltip: None,
            kind: DecorationKind::LineEnd { text: text.into(), tone: None },
        }
    }

    #[test]
    fn decorations_come_in_the_order_of_their_sources_names() {
        // The editor draws the first line-end text of a row, so a source named `agent.blame`
        // takes the end of the line from `git.blame`.
        let mut state = EditorState::new(Buffer::from_text("one\ntwo\n"));
        state.set_decorations("git.blame", &[line_end(1, "Ada, 3 days ago")]);
        state.set_decorations("agent.blame", &[line_end(1, "an agent wrote this")]);
        let placed = state.decorations_in_rows(0..usize::MAX);
        let texts: Vec<&str> = placed
            .iter()
            .filter_map(|placed| match placed.kind {
                DecorationKind::LineEnd { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["an agent wrote this", "Ada, 3 days ago"]);
    }

    fn type_at(state: &mut EditorState, position: Position, text: &str) {
        state.apply(&Command::PlaceCursor { at: position });
        state.apply(&Command::InsertText { text: text.into() });
    }

    /// The range of the one highlight the state has.
    fn range_of(state: &EditorState) -> (Position, Position) {
        let placed = state.decorations_in_rows(0..usize::MAX);
        let first = placed.iter().find(|placed| matches!(placed.kind, DecorationKind::Highlight { .. }));
        let first = first.expect("a highlight");
        (first.start, first.end)
    }

    #[test]
    fn a_range_keeps_its_text_when_lines_are_added_above() {
        let mut state = EditorState::new(Buffer::from_text("one\ntwo three\nfour\n"));
        state.set_decorations("lsp", &[squiggle(at(1, 4), at(1, 9))]);
        type_at(&mut state, at(0, 0), "new line\n");
        assert_eq!(range_of(&state), (at(2, 4), at(2, 9)));
    }

    #[test]
    fn typing_before_a_range_on_its_line_shifts_its_columns() {
        let mut state = EditorState::new(Buffer::from_text("one two three\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 4), at(0, 7))]);
        type_at(&mut state, at(0, 0), "xx");
        assert_eq!(range_of(&state), (at(0, 6), at(0, 9)));
    }

    #[test]
    fn typing_inside_a_range_grows_it_and_after_it_leaves_it() {
        let mut state = EditorState::new(Buffer::from_text("one two three\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 4), at(0, 7))]);
        type_at(&mut state, at(0, 5), "ZZ");
        assert_eq!(range_of(&state), (at(0, 4), at(0, 9)));
        type_at(&mut state, at(0, 9), "!");
        assert_eq!(range_of(&state), (at(0, 4), at(0, 9)));
    }

    #[test]
    fn typing_exactly_at_the_edges_stays_outside_a_highlight() {
        let mut state = EditorState::new(Buffer::from_text("one two three\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 4), at(0, 7))]);
        type_at(&mut state, at(0, 4), "<");
        assert_eq!(range_of(&state), (at(0, 5), at(0, 8)));
    }

    #[test]
    fn deleting_text_around_a_range_pulls_it_along() {
        let mut state = EditorState::new(Buffer::from_text("one two three\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 4), at(0, 7))]);
        state.apply(&Command::SelectAll);
        state.apply(&Command::PlaceCursor { at: at(0, 4) });
        state.apply(&Command::ExtendNewestTo { at: at(0, 6) });
        state.apply(&Command::Delete { motion: crate::movement::Motion::Left });
        assert_eq!(range_of(&state), (at(0, 4), at(0, 5)));
    }

    #[test]
    fn deleting_the_whole_range_collapses_it_to_a_point() {
        let mut state = EditorState::new(Buffer::from_text("one two three\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 4), at(0, 7))]);
        state.apply(&Command::PlaceCursor { at: at(0, 3) });
        state.apply(&Command::ExtendNewestTo { at: at(0, 8) });
        state.apply(&Command::Delete { motion: crate::movement::Motion::Left });
        let (start, end) = range_of(&state);
        assert_eq!(start, end);
    }

    #[test]
    fn an_inlay_stays_after_the_text_typed_at_it() {
        let mut state = EditorState::new(Buffer::from_text("let x = 1;\n"));
        state.set_decorations("lsp.types", &[inlay(at(0, 5), ": i32")]);
        type_at(&mut state, at(0, 5), "y");
        let placed = state.decorations_in_rows(0..1);
        assert_eq!(placed[0].start, at(0, 6));
    }

    #[test]
    fn replacing_a_source_leaves_the_others_alone() {
        let mut state = EditorState::new(Buffer::from_text("one\ntwo\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 0), at(0, 3)), squiggle(at(1, 0), at(1, 3))]);
        state.set_decorations("git", &[inlay(at(1, 1), "x")]);
        state.set_decorations("lsp", &[squiggle(at(0, 1), at(0, 2))]);
        assert_eq!(state.decoration_count("lsp"), 1);
        assert_eq!(state.decoration_count("git"), 1);
        let kinds: Vec<_> = state.decorations_in_rows(0..2).iter().map(|placed| placed.start).collect();
        assert_eq!(kinds.len(), 2);
        state.set_decorations("lsp", &[]);
        assert_eq!(state.decoration_count("lsp"), 0);
        assert_eq!(state.decoration_count("git"), 1);
    }

    #[test]
    fn replacing_a_source_frees_the_anchors_it_held() {
        let mut state = EditorState::new(Buffer::from_text("one\n"));
        for _ in 0..3 {
            state.set_decorations("lsp", &[squiggle(at(0, 0), at(0, 3))]);
        }
        state.set_decorations("lsp", &[]);
        assert_eq!(state.anchor_count(), 0);
    }

    #[test]
    fn rows_outside_the_asked_range_are_left_out() {
        let mut state = EditorState::new(Buffer::from_text("a\nb\nc\nd\n"));
        state.set_decorations("lsp", &[squiggle(at(0, 0), at(0, 1)), squiggle(at(3, 0), at(3, 1))]);
        assert_eq!(state.decorations_in_rows(1..3).len(), 0);
        assert_eq!(state.decorations_in_rows(2..4).len(), 1);
    }

    #[test]
    fn a_source_that_belongs_to_a_view_is_shown_by_that_view_alone() {
        let diff = SourceFilter { view: "pane-1".into(), hidden: Vec::new() };
        let other = SourceFilter { view: "pane-2".into(), hidden: Vec::new() };
        let plain = SourceFilter::default();
        assert!(diff.shows("view:pane-1:diff"));
        assert!(!other.shows("view:pane-1:diff"));
        assert!(!plain.shows("view:pane-1:diff"));
        assert!(!SourceFilter { view: "pane-1".into(), hidden: Vec::new() }.shows("view:pane-10:diff"));
        assert!(diff.shows("git.blame") && other.shows("git.blame") && plain.shows("git.blame"));
    }

    #[test]
    fn a_view_can_hide_a_source_of_the_document_by_name() {
        let filter = SourceFilter { view: String::new(), hidden: vec!["git.changes".into()] };
        assert!(!filter.shows("git.changes"));
        assert!(filter.shows("git.blame"));
    }

    #[test]
    fn a_view_local_set_is_not_visible_to_another_view_of_the_same_document() {
        let mut state = EditorState::new(Buffer::from_text("a\nb\n"));
        state.set_decorations("view:pane-1:diff", &[squiggle(at(0, 0), at(0, 1))]);
        state.set_decorations("git.changes", &[squiggle(at(1, 0), at(1, 1))]);
        let diff = SourceFilter { view: "pane-1".into(), hidden: vec!["git.changes".into()] };
        let tab = SourceFilter::default();
        let rows = |filter: &SourceFilter| -> Vec<usize> {
            state.decorations_in_rows_for(0..2, filter).iter().map(|placed| placed.start.row).collect()
        };
        assert_eq!(rows(&diff), vec![0]);
        assert_eq!(rows(&tab), vec![1]);
    }

    #[test]
    fn blocks_are_ordered_by_where_they_go() {
        let block = |row: usize, placement: Placement| Decoration {
            start: at(row, 0),
            end: None,
            tooltip: None,
            kind: DecorationKind::Block {
                lines: vec!["x".into()],
                placement,
                tone: None,
                emphasis: Vec::new(),
                key: None,
            },
        };
        let mut state = EditorState::new(Buffer::from_text("a\nb\nc\n"));
        state.set_decorations(
            "diff",
            &[block(2, Placement::Below), block(0, Placement::Above), block(0, Placement::Below)],
        );
        let slots: Vec<usize> = state.decoration_blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![0, 1, 3]);
    }

    #[test]
    fn decorations_read_from_the_json_a_source_sends() {
        let json = r#"[
            {"start": {"row": 1, "column": 2}, "end": {"row": 1, "column": 5}, "kind": "highlight",
             "underline": {"style": "squiggle", "tone": "error"}},
            {"start": {"row": 0, "column": 3}, "kind": "inlay", "text": ": i32"},
            {"start": {"row": 0, "column": 0}, "end": {"row": 4, "column": 0}, "kind": "gutter", "mark": "bar", "tone": "added"},
            {"start": {"row": 2, "column": 0}, "kind": "gutter", "mark": {"glyph": "!"}},
            {"start": {"row": 2, "column": 0}, "kind": "block", "lines": ["- old"], "placement": "above"}
        ]"#;
        let parsed: Vec<Decoration> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.len(), 5);
        assert_eq!(parsed[2].kind, DecorationKind::Gutter { mark: GutterMark::Bar, tone: Some(Tone::Added) });
        assert_eq!(parsed[3].kind, DecorationKind::Gutter { mark: GutterMark::Glyph('!'), tone: None });
        assert_eq!(parsed[0].tooltip, None);
    }

    #[test]
    fn a_block_can_carry_a_key_the_app_finds_it_by() {
        let json = r#"{"start": {"row": 3, "column": 0}, "kind": "block", "lines": ["", ""], "key": "comment:3"}"#;
        let parsed: Decoration = serde_json::from_str(json).unwrap();
        let mut state = EditorState::new(Buffer::from_text("a\nb\nc\nd\ne\n"));
        state.set_decorations("review", &[parsed]);
        let blocks = state.decoration_blocks_for(&SourceFilter::default());
        assert_eq!(blocks[0].key, Some("comment:3"));
        assert_eq!(blocks[0].slot, 4);
    }

    #[test]
    fn a_tooltip_travels_with_the_decoration() {
        let mut state = EditorState::new(Buffer::from_text("one two\n"));
        let mut squiggled = squiggle(at(0, 4), at(0, 7));
        squiggled.tooltip = Some("not a word".into());
        state.set_decorations("lsp", &[squiggled]);
        type_at(&mut state, at(0, 0), "xx");
        let placed = state.decorations_in_rows(0..1);
        assert_eq!(placed[0].tooltip, Some("not a word"));
        assert_eq!(placed[0].start, at(0, 6));
    }
}
