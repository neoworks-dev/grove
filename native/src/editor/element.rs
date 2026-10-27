//! The GPUI element that paints the editor. Like Zed's `EditorElement`, it is one element
//! for the whole viewport rather than one per line: each frame it works out which rows the
//! scroll offset makes visible, shapes only those, and paints them. GPUI's text system keeps
//! shaped lines from the previous frame, so rows that did not change are not shaped again.
//!
//! Rows here are display rows: the buffer's lines with the rows of blocks (see
//! `editor_core::display::BlockMap`) between them. Inlays are part of the shaped text of a line.
//! Other decorations are painted around it: ranges behind and under the text, marks in the gutter,
//! and text after the end of a line.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use svelte_gpui::gpui::{
    App, Bounds, ContentMask, Element, ElementId, ElementInputHandler, Entity, Font, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, Pixels, ShapedLine, SharedString, Style, TextRun, UnderlineStyle,
    Window, fill, font, point, px, relative, size,
};

use super::Editor;
use super::indent_paint::{self, GuideLine};
use super::jump_paint::{self, JumpPaint};
use super::minimap::{self, MinimapPaint};
use super::options::EditorOptions;
use super::popup;
use super::theme::{EditorTheme, HighlightStyle};
use super::vim_paint::{self, VimPaint};
use editor_core::decorations::{DecorationKind, GutterMark, Placed, PlacedBlock, Placement, Tone, UnderlineKind};
use editor_core::display::{BlockMap, BlockSlot, DisplayLine, DisplayRow, InlayText};
use editor_core::jump::JumpSession;
use editor_core::syntax::HighlightSpan;
use editor_core::{EditorState, InputStatus, Position, SourceFilter};

pub const FONT_FAMILY: &str = "DejaVu Sans Mono";
pub const FONT_SIZE: Pixels = px(14.0);
pub const LINE_HEIGHT: Pixels = px(21.0);
/// Space on each side of the line numbers.
const GUTTER_PADDING: Pixels = px(16.0);
const CURSOR_WIDTH: Pixels = px(2.0);
/// How wide a selected line ending is drawn.
pub(super) const LINE_ENDING_WIDTH: Pixels = px(7.0);

const UNDERLINE_HEIGHT: Pixels = px(1.5);
/// How thick the line under a highlighted range is; a squiggle is three times as tall.
const DECORATION_UNDERLINE_THICKNESS: Pixels = px(1.2);
/// The width of a changed-lines bar in the gutter, and how far from the window's edge it is.
const GUTTER_BAR_WIDTH: Pixels = px(3.0);
const GUTTER_BAR_INSET: Pixels = px(3.0);
/// The size of a dot in the gutter.
const GUTTER_DOT_SIZE: Pixels = px(8.0);
/// The size of the notch that marks deleted lines.
const GUTTER_NOTCH_WIDTH: Pixels = px(9.0);
const GUTTER_NOTCH_HEIGHT: Pixels = px(2.0);
/// Space between the end of a line and the text added after it.
const LINE_END_GAP: Pixels = px(28.0);
/// How opaque a tone is when it is a background behind text.
const BACKGROUND_OPACITY: f32 = 0.18;
/// How opaque a tone is behind a block's rows.
const BLOCK_OPACITY: f32 = 0.12;
/// How opaque the words a diff changed are behind their text, over the tint of their line.
const WORD_OPACITY: f32 = 0.38;
/// How opaque the filler rows of a side-by-side diff are.
const FILLER_OPACITY: f32 = 0.07;
/// How wide the line between the two sides of a side-by-side diff is.
const DIVIDER_WIDTH: Pixels = px(1.0);
/// How tall the band over each side of a side-by-side diff is, which has the side's name.
const LABEL_BAND_HEIGHT: Pixels = px(24.0);
/// The size of a side's name.
const LABEL_FONT_SIZE: Pixels = px(12.0);

/// What the last frame drew, kept on the editor so the pointer can be mapped to a position
/// and the cursor kept in view.
pub struct Layout {
    pub bounds: Bounds<Pixels>,
    /// Where the text starts, right of the gutter.
    pub text_left: Pixels,
    /// The first display row drawn, and the y of its top, which is above `bounds` while it is
    /// scrolled partly out.
    pub first_display_row: usize,
    pub first_row_top: Pixels,
    /// Where the blocks are, which turns buffer rows into display rows.
    pub blocks: BlockMap,
    /// The display rows drawn, from `first_display_row` on.
    pub rows: Vec<VisibleRow>,
    /// Where the minimap is, while there is one, so a press on it is not taken for one on the text.
    pub minimap: Option<Bounds<Pixels>>,
    /// The blocks that have a key, and the display rows they are on.
    pub keyed_blocks: Vec<KeyedBlock>,
}

/// A block the app named, and where it is: the app puts its own widget over its rows.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyedBlock {
    pub key: String,
    /// The display rows the block covers.
    pub rows: Range<usize>,
}

/// A display row that was drawn.
pub enum VisibleRow {
    Text(VisibleLine),
    /// A row of a block pinned to a buffer row.
    Block {
        row: usize,
        placement: Placement,
    },
}

/// A line of the buffer that was drawn.
pub struct VisibleLine {
    /// The buffer row.
    pub row: usize,
    pub display: DisplayLine,
    pub shaped: ShapedLine,
}

impl Layout {
    /// How many whole rows fit in the viewport.
    pub fn rows_in_view(&self) -> usize {
        (self.bounds.size.height / LINE_HEIGHT).floor().max(1.0) as usize
    }

    /// The buffer position nearest a point in the window. A row of a block stands for the line it
    /// is pinned to.
    pub fn position_for_point(&self, point: svelte_gpui::gpui::Point<Pixels>) -> Position {
        let rows_down = ((point.y - self.first_row_top) / LINE_HEIGHT).floor().max(0.0) as usize;
        match self.rows.get(rows_down) {
            Some(VisibleRow::Text(line)) => {
                let offset = line.shaped.closest_index_for_x(point.x - self.text_left);
                Position { row: line.row, column: line.display.column_at(offset) }
            }
            Some(VisibleRow::Block { row, placement: Placement::Above }) => Position { row: *row, column: 0 },
            Some(VisibleRow::Block { row, placement: Placement::Below }) => Position { row: *row, column: usize::MAX },
            None => match self.blocks.row_at(self.first_display_row + rows_down) {
                DisplayRow::Text(row) => Position { row, column: usize::MAX },
                DisplayRow::Block { .. } => Position { row: usize::MAX, column: usize::MAX },
            },
        }
    }

    /// Whether a point in the window is on the minimap.
    pub fn over_minimap(&self, point: svelte_gpui::gpui::Point<Pixels>) -> bool {
        match self.minimap {
            Some(strip) => strip.contains(&point),
            None => false,
        }
    }

    /// Whether a point is on the text of a line, rather than the gutter or past the line's end.
    pub fn over_text(&self, point: svelte_gpui::gpui::Point<Pixels>) -> bool {
        let rows_down = ((point.y - self.first_row_top) / LINE_HEIGHT).floor().max(0.0) as usize;
        let Some(VisibleRow::Text(line)) = self.rows.get(rows_down) else {
            return false;
        };
        point.x >= self.text_left && point.x <= self.text_left + line.shaped.width
    }

    /// The y of the top of the drawn display row at `index` (counted from the first drawn).
    pub(super) fn top_of_index(&self, index: usize) -> Pixels {
        self.first_row_top + LINE_HEIGHT * index as f32
    }

    /// The drawn line of a buffer row and the y of its top, or none while it is out of view.
    pub(super) fn line_of(&self, row: usize) -> Option<(&VisibleLine, Pixels)> {
        let index = self.blocks.display_row_of(row).checked_sub(self.first_display_row)?;
        match self.rows.get(index)? {
            VisibleRow::Text(line) if line.row == row => Some((line, self.top_of_index(index))),
            _ => None,
        }
    }
}

pub struct EditorElement {
    pub editor: Entity<Editor>,
}

/// One row as this frame paints it.
struct PaintedRow {
    top: Pixels,
    /// The line number and where it starts; a row of a block has none.
    number: Option<(ShapedLine, Pixels)>,
    text: ShapedLine,
    is_cursor_row: bool,
    /// Behind the whole row, for the rows of a block and the lines a diff marks.
    tint: Option<Hsla>,
    /// Behind stretches of the row's text, such as the words a diff changed in a removed line.
    emphasis: Vec<(Bounds<Pixels>, Hsla)>,
}

/// A line under a decorated range.
struct DecorationUnderline {
    origin: svelte_gpui::gpui::Point<Pixels>,
    width: Pixels,
    wavy: bool,
    color: Hsla,
}

/// A mark in the gutter.
enum GutterPaint {
    Shape { bounds: Bounds<Pixels>, color: Hsla, radius: Pixels },
    Glyph { shaped: ShapedLine, origin: svelte_gpui::gpui::Point<Pixels> },
}

/// The name of one side of a side-by-side diff, and the band over that side it is drawn in.
struct SideLabel {
    band: Bounds<Pixels>,
    shaped: ShapedLine,
}

/// Text added after the end of a line.
struct LineEndPaint {
    shaped: ShapedLine,
    origin: svelte_gpui::gpui::Point<Pixels>,
}

pub struct Frame {
    /// The box the frame is painted in: the whole element, or one side of a side-by-side diff.
    bounds: Bounds<Pixels>,
    /// The old side of a side-by-side diff, painted left of this one, when the view has one.
    companion: Option<Box<Frame>>,
    /// What this side of a side-by-side diff is called, drawn in a band above `bounds`.
    label: Option<SideLabel>,
    rows: Vec<PaintedRow>,
    gutter_width: Pixels,
    /// Behind the text: the parts of selections in view.
    selections: Vec<Bounds<Pixels>>,
    /// Behind the text: the ranges decorations colour.
    range_backgrounds: Vec<(Bounds<Pixels>, Hsla)>,
    /// Behind the text: a line per indentation level.
    guides: Vec<GuideLine>,
    /// Under the text: lines and squiggles decorations draw.
    decoration_underlines: Vec<DecorationUnderline>,
    gutter_marks: Vec<GutterPaint>,
    line_ends: Vec<LineEndPaint>,
    cursors: Vec<Bounds<Pixels>>,
    /// Under the text an input method is composing.
    underlines: Vec<Bounds<Pixels>>,
    /// What vim mode adds: block cursors and the command line.
    vim: VimPaint,
    /// What a jump in progress adds: labels, and the matches they stand for.
    jump: JumpPaint,
    /// The overview of the whole buffer at the right edge, when the view has one.
    minimap: Option<MinimapPaint>,
    /// The colours this frame is painted with.
    theme: EditorTheme,
    /// How long the frame took to prepare, for `GROVE_LATENCY`.
    prepaint_took: std::time::Duration,
}

impl Frame {
    /// What is drawn for a view that shows no document: the background and nothing else.
    fn empty(theme: EditorTheme) -> Frame {
        Frame {
            theme,
            bounds: Bounds::default(),
            companion: None,
            label: None,
            rows: Vec::new(),
            gutter_width: px(0.0),
            selections: Vec::new(),
            range_backgrounds: Vec::new(),
            guides: Vec::new(),
            decoration_underlines: Vec::new(),
            gutter_marks: Vec::new(),
            line_ends: Vec::new(),
            cursors: Vec::new(),
            underlines: Vec::new(),
            prepaint_took: std::time::Duration::ZERO,
            vim: VimPaint::default(),
            jump: JumpPaint::default(),
            minimap: None,
        }
    }
}

impl IntoElement for EditorElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for EditorElement {
    type RequestLayoutState = ();
    type PrepaintState = Frame;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    /// Fills whatever box the editor is given.
    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.0).into();
        style.size.height = relative(1.0).into();
        (window.request_layout(style, [], cx), ())
    }

    /// Shapes the visible rows, works out where the selections, cursors and decorations in view
    /// are drawn, and records the layout on the editor.
    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Frame {
        let prepaint_started = std::time::Instant::now();
        self.editor.update(cx, |editor, cx| editor.advance_glide(window, cx));
        let editor = self.editor.read(cx);
        let scroll_top = editor.scroll_top;
        let theme = editor.theme.clone();
        let status = editor.input.status();
        let options = editor.documents.options();
        let jump = editor.jump.as_ref();
        let sources = editor.sources.clone();
        let minimap_width = editor.minimap_width;
        let furthest_scroll = editor.furthest_scroll();
        let mut own_bounds = bounds;
        let mut companion = None;
        let mut own_label = None;
        if let Some(companion_id) = editor.companion {
            let (mut left, right) = split_bounds(bounds);
            own_bounds = right;
            let mut companion_label = None;
            if let [old_label, new_label] = editor.side_labels.as_slice() {
                let (left_band, left_body) = take_label_band(left);
                let (right_band, right_body) = take_label_band(right);
                left = left_body;
                own_bounds = right_body;
                companion_label =
                    Some(SideLabel { band: left_band, shaped: shape_label(window, old_label, theme.hint) });
                own_label = Some(SideLabel { band: right_band, shaped: shape_label(window, new_label, theme.hint) });
            }
            companion = editor.read_document(companion_id, |state| {
                let (_, mut frame) =
                    build_frame(state, scroll_top, left, window, &theme, &status, options, None, &sources, false);
                frame.label = companion_label;
                Box::new(frame)
            });
        }
        // Side by side, each half is too narrow to give a strip of it to the minimap.
        let wants_minimap = companion.is_none();
        let built = editor.read(|state| {
            let (mut layout, mut frame) =
                build_frame(state, scroll_top, own_bounds, window, &theme, &status, options, jump, &sources, true);
            if wants_minimap {
                attach_minimap(&mut layout, &mut frame, state, minimap_width, scroll_top, furthest_scroll);
            }
            (layout, frame)
        });
        let Some((layout, mut frame)) = built else {
            return Frame::empty(theme);
        };
        frame.companion = companion;
        frame.label = own_label;
        let entity = self.editor.clone();
        let popovers = self.editor.update(cx, |editor, cx| {
            let popovers = popup::build(&entity, editor, &layout, &theme, bounds, window, cx);
            editor.layout = Some(layout);
            editor.report_places();
            editor.center_pending_row(cx);
            editor.hints_may_be_stale(cx);
            popovers
        });
        for popover in popovers {
            window.defer_draw(popover.element, popover.origin, 1);
        }
        frame.prepaint_took = prepaint_started.elapsed();
        frame
    }

    /// Paints the background, the cursors' lines, decorated ranges, selections, the gutter, the
    /// text, what is drawn under and after it, and the cursors.
    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        frame: &mut Frame,
        window: &mut Window,
        cx: &mut App,
    ) {
        let paint_started = std::time::Instant::now();
        let focus = self.editor.read(cx).focus.clone();
        let focused = focus.is_focused(window);
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            window.paint_quad(fill(bounds, frame.theme.background));
        });
        if let Some(companion) = &frame.companion {
            paint_frame(companion, focused, window, cx);
            let divider = Bounds::new(
                point(frame.bounds.left() - DIVIDER_WIDTH, bounds.top()),
                size(DIVIDER_WIDTH, bounds.size.height),
            );
            window.paint_quad(fill(divider, frame.theme.indent_guide));
        }
        paint_frame(frame, focused, window, cx);
        self.report_latency(frame, paint_started, cx);
    }
}

/// Paints one frame inside its box: the cursors' lines, decorated ranges, selections, the gutter,
/// the text, what is drawn under and after it, and the cursors.
fn paint_frame(frame: &Frame, focused: bool, window: &mut Window, cx: &mut App) {
    if let Some(label) = &frame.label {
        paint_side_label(label, frame.gutter_width, &frame.theme, window, cx);
    }
    let bounds = frame.bounds;
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        let theme = &frame.theme;
        for row in &frame.rows {
            let line = Bounds::new(point(bounds.left(), row.top), size(bounds.size.width, LINE_HEIGHT));
            if let Some(tint) = row.tint {
                window.paint_quad(fill(line, tint));
            }
            for (span, color) in &row.emphasis {
                window.paint_quad(fill(*span, *color));
            }
            if row.is_cursor_row {
                window.paint_quad(fill(line, theme.current_line));
            }
        }
        indent_paint::paint_guides(&frame.guides, theme, window);
        for (range, color) in &frame.range_backgrounds {
            window.paint_quad(fill(*range, *color));
        }
        for selection in &frame.selections {
            window.paint_quad(fill(*selection, theme.selection));
        }
        jump_paint::paint_behind_text(&frame.jump, theme, window);
        vim_paint::paint_behind_text(&frame.vim, theme, focused, window);
        for mark in &frame.gutter_marks {
            paint_gutter_mark(mark, window, cx);
        }
        let text_left = bounds.left() + frame.gutter_width;
        for row in &frame.rows {
            if let Some((number, number_left)) = &row.number {
                let _ = number.paint(point(*number_left, row.top), LINE_HEIGHT, window, cx);
            }
            let _ = row.text.paint(point(text_left, row.top), LINE_HEIGHT, window, cx);
        }
        for line_end in &frame.line_ends {
            let _ = line_end.shaped.paint(line_end.origin, LINE_HEIGHT, window, cx);
        }
        for underline in &frame.decoration_underlines {
            let style = UnderlineStyle {
                thickness: DECORATION_UNDERLINE_THICKNESS,
                color: Some(underline.color),
                wavy: underline.wavy,
            };
            window.paint_underline(underline.origin, underline.width, &style);
        }
        for underline in &frame.underlines {
            window.paint_quad(fill(*underline, theme.foreground));
        }
        let mut cursor_color = theme.cursor;
        if !focused {
            cursor_color.a = 0.4;
        }
        for cursor in &frame.cursors {
            window.paint_quad(fill(*cursor, cursor_color));
        }
        jump_paint::paint_over_text(&frame.jump, theme, window, cx);
        if let Some(minimap) = &frame.minimap {
            minimap::paint(minimap, theme, window);
        }
        vim_paint::paint_command_line(&frame.vim, theme, window, cx);
    });
}

/// Takes the band a side's name is drawn in off the top of the side's box: answers the band, and
/// the box below it that the side's text is drawn in.
fn take_label_band(bounds: Bounds<Pixels>) -> (Bounds<Pixels>, Bounds<Pixels>) {
    let height = LABEL_BAND_HEIGHT.min(bounds.size.height);
    let band = Bounds::new(bounds.origin, size(bounds.size.width, height));
    let body =
        Bounds::new(point(bounds.left(), bounds.top() + height), size(bounds.size.width, bounds.size.height - height));
    (band, body)
}

/// Paints a side's name in its band, where the side's text starts, with a line under the band.
fn paint_side_label(label: &SideLabel, gutter_width: Pixels, theme: &EditorTheme, window: &mut Window, cx: &mut App) {
    let band = label.band;
    window.with_content_mask(Some(ContentMask { bounds: band }), |window| {
        let _ = label.shaped.paint(point(band.left() + gutter_width, band.top()), band.size.height, window, cx);
    });
    let rule = Bounds::new(point(band.left(), band.bottom() - DIVIDER_WIDTH), size(band.size.width, DIVIDER_WIDTH));
    window.paint_quad(fill(rule, theme.indent_guide));
}

/// Shapes the name of a side of a side-by-side diff in the editor's font, smaller than the text.
fn shape_label(window: &mut Window, text: &str, color: Hsla) -> ShapedLine {
    let plain = HighlightStyle { color, bold: false, italic: false };
    let run = text_run(text.len(), plain, None);
    window.text_system().shape_line(SharedString::from(text.to_string()), LABEL_FONT_SIZE, &[run], None)
}

/// Splits the element's box for a side-by-side diff: the old side on the left, the document on
/// the right, with the divider between them.
fn split_bounds(bounds: Bounds<Pixels>) -> (Bounds<Pixels>, Bounds<Pixels>) {
    let half = (bounds.size.width / 2.0).floor();
    let left = Bounds::new(bounds.origin, size(half - DIVIDER_WIDTH, bounds.size.height));
    let right =
        Bounds::new(point(bounds.left() + half, bounds.top()), size(bounds.size.width - half, bounds.size.height));
    (left, right)
}

impl EditorElement {
    /// Prints how long the keystroke that caused this frame took, when `GROVE_LATENCY` is set:
    /// from reaching the view to the end of painting, and the parts of that.
    fn report_latency(&self, frame: &Frame, paint_started: std::time::Instant, cx: &mut App) {
        if !self.editor.read(cx).measure_latency {
            return;
        }
        let Some(probe) = self.editor.update(cx, |editor, _| editor.latency_probe.take()) else {
            return;
        };
        let waited = paint_started.duration_since(probe.arrived_at).saturating_sub(frame.prepaint_took);
        eprintln!(
            "[latency] handled {:.2} ms, waited for the frame {:.2} ms, prepared {:.2} ms, painted {:.2} ms, key to end of paint {:.2} ms",
            probe.handled.as_secs_f64() * 1000.0,
            waited.as_secs_f64() * 1000.0,
            frame.prepaint_took.as_secs_f64() * 1000.0,
            paint_started.elapsed().as_secs_f64() * 1000.0,
            probe.arrived_at.elapsed().as_secs_f64() * 1000.0,
        );
    }
}

/// Paints one mark in the gutter.
fn paint_gutter_mark(mark: &GutterPaint, window: &mut Window, cx: &mut App) {
    match mark {
        GutterPaint::Shape { bounds, color, radius } => {
            window.paint_quad(fill(*bounds, *color).corner_radii(*radius));
        }
        GutterPaint::Glyph { shaped, origin } => {
            let _ = shaped.paint(*origin, LINE_HEIGHT, window, cx);
        }
    }
}

/// The decorations a frame needs, sorted out by what they do to the row they are on.
struct RowDecorations<'a> {
    /// Inlays by buffer row, ordered by column.
    inlays: HashMap<usize, Vec<(usize, &'a str, Tone)>>,
    /// The text after the end of a line, by buffer row.
    line_ends: HashMap<usize, (&'a str, Tone)>,
}

impl<'a> RowDecorations<'a> {
    /// Picks the inlays and line-end text out of the decorations in view. Where several put text
    /// after one line, the first wins.
    fn new(decorations: &[Placed<'a>]) -> Self {
        let mut inlays: HashMap<usize, Vec<(usize, &str, Tone)>> = HashMap::new();
        let mut line_ends = HashMap::new();
        for placed in decorations {
            match placed.kind {
                DecorationKind::Inlay { text, tone } => {
                    let tone = tone.unwrap_or(Tone::Inlay);
                    inlays.entry(placed.start.row).or_default().push((placed.start.column, text.as_str(), tone));
                }
                DecorationKind::LineEnd { text, tone } => {
                    line_ends.entry(placed.start.row).or_insert((text.as_str(), tone.unwrap_or(Tone::LineEnd)));
                }
                _ => {}
            }
        }
        for row_inlays in inlays.values_mut() {
            row_inlays.sort_by_key(|(column, _, _)| *column);
        }
        RowDecorations { inlays, line_ends }
    }
}

/// The buffer rows that display rows show, as the first and one past the last, or an empty range
/// when none shows a line.
fn text_row_range(display_rows: &[DisplayRow]) -> Range<usize> {
    let mut rows = display_rows.iter().filter_map(|row| match row {
        DisplayRow::Text(row) => Some(*row),
        DisplayRow::Block { .. } => None,
    });
    let Some(first) = rows.next() else {
        return 0..0;
    };
    first..rows.last().unwrap_or(first) + 1
}

/// Where the blocks go, for the display map.
fn block_map(blocks: &[PlacedBlock]) -> BlockMap {
    let slots: Vec<BlockSlot> =
        blocks.iter().map(|block| BlockSlot { slot: block.slot, height: block.lines.len() }).collect();
    BlockMap::new(&slots)
}

/// Shapes the rows in view, coloured by their syntax, and works out where the selections,
/// cursors and decorations are drawn, for a state scrolled to `scroll_top` in a box of `bounds`.
/// Also gives the layout the pointer is mapped through. A frame that is not `active`, such as the
/// old side of a side-by-side diff, has no cursors or selections, only the text and its decorations.
#[allow(clippy::too_many_arguments)]
fn build_frame(
    state: &EditorState,
    scroll_top: Pixels,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    theme: &EditorTheme,
    status: &InputStatus,
    options: EditorOptions,
    jump: Option<&JumpSession>,
    sources: &SourceFilter,
    active: bool,
) -> (Layout, Frame) {
    let line_count = state.buffer().line_count();
    let digits = line_count.max(1).to_string().len();
    let digit_width = shape_plain(window, &"0".repeat(digits), theme.line_number).width;
    let gutter_width = digit_width + GUTTER_PADDING * 2.0;
    let text_left = bounds.left() + gutter_width;

    let blocks = state.decoration_blocks_for(sources);
    let blocks_map = block_map(&blocks);
    let first_display_row = (scroll_top / LINE_HEIGHT).floor() as usize;
    let first_row_top = bounds.top() - (scroll_top - LINE_HEIGHT * first_display_row as f32);
    let rows_drawn = (bounds.size.height / LINE_HEIGHT).ceil() as usize + 1;
    let end_display_row = (first_display_row + rows_drawn).min(blocks_map.total_rows(line_count));
    let display_rows: Vec<DisplayRow> =
        (first_display_row..end_display_row).map(|row| blocks_map.row_at(row)).collect();
    let text_rows = text_row_range(&display_rows);

    let mut visible_selections = state.selections().in_rows(text_rows.start, text_rows.end);
    if !active {
        visible_selections = &[];
    }
    let cursor_rows: HashSet<usize> = visible_selections
        .iter()
        .filter(|selection| selection.is_empty())
        .map(|selection| selection.head.row)
        .collect();
    let syntax = state.highlights(text_rows.clone());
    let decorations = state.decorations_in_rows_for(text_rows.clone(), sources);
    let row_decorations = RowDecorations::new(&decorations);
    let line_tints = line_tints(&decorations, theme);

    let mut visible_rows = Vec::with_capacity(display_rows.len());
    let mut painted_rows = Vec::with_capacity(display_rows.len());
    let mut line_ends = Vec::new();
    for (index, display_row) in display_rows.iter().enumerate() {
        let top = first_row_top + LINE_HEIGHT * index as f32;
        match *display_row {
            DisplayRow::Text(row) => {
                let is_cursor_row = cursor_rows.contains(&row);
                let number_color = if is_cursor_row { theme.current_line_number } else { theme.line_number };
                let number = shape_plain(window, &(row + 1).to_string(), number_color);
                let number_left = bounds.left() + GUTTER_PADDING + digit_width - number.width;
                let inlays = row_decorations.inlays.get(&row).map(Vec::as_slice).unwrap_or_default();
                let display = line_with_inlays(&state.buffer().line(row), inlays);
                let inlay_tones: Vec<Tone> = inlays.iter().map(|(_, _, tone)| *tone).collect();
                let runs = text_runs(&display, &syntax[row - text_rows.start], &inlay_tones, theme);
                let text = shape_runs(window, &display.text, &runs);
                if let Some((line_end_text, tone)) = row_decorations.line_ends.get(&row) {
                    let shaped = shape_italic(window, line_end_text, theme.tone(*tone));
                    let origin = point(text_left + text.width + LINE_END_GAP, top);
                    line_ends.push(LineEndPaint { shaped, origin });
                }
                painted_rows.push(PaintedRow {
                    top,
                    number: Some((number, number_left)),
                    text: text.clone(),
                    is_cursor_row,
                    tint: line_tints.get(&row).copied(),
                    emphasis: Vec::new(),
                });
                visible_rows.push(VisibleRow::Text(VisibleLine { row, display, shaped: text }));
            }
            DisplayRow::Block { block, line } => {
                let placed = &blocks[block];
                let tone = placed.tone.unwrap_or(Tone::Inlay);
                let color = theme.tone(tone);
                let display = DisplayLine::new(&placed.lines[line]);
                let text = shape_plain(window, &display.text, color);
                let emphasis = block_emphasis(placed, line, &display, &text, text_left, top, theme);
                painted_rows.push(PaintedRow {
                    top,
                    number: None,
                    text,
                    is_cursor_row: false,
                    tint: Some(color.opacity(block_opacity(tone))),
                    emphasis,
                });
                visible_rows.push(VisibleRow::Block { row: placed.row, placement: placed.placement });
            }
        }
    }

    let keyed = keyed_blocks(&blocks, &blocks_map);
    let layout = Layout {
        bounds,
        text_left,
        first_display_row,
        first_row_top,
        blocks: blocks_map,
        rows: visible_rows,
        minimap: None,
        keyed_blocks: keyed,
    };
    let selections = visible_selections
        .iter()
        .flat_map(|selection| vim_paint::selection_spans(&layout, selection, status.selection))
        .collect();
    let character_width = vim_paint::character_width(window, theme.foreground);
    let mut underlines = Vec::new();
    let mut cursors = Vec::new();
    let mut vim = VimPaint::default();
    if active {
        underlines = state.marked_range().map(|(start, end)| underline_bounds(&layout, start, end)).unwrap_or_default();
        let (cursor_bounds, block_cursors) =
            vim_paint::cursor_bounds_for(&layout, visible_selections, status, character_width);
        cursors = cursor_bounds;
        vim = VimPaint { block_cursors, command_line: vim_paint::command_line(&layout, status, theme, window) };
    }
    let (range_backgrounds, decoration_underlines) = range_decorations(&layout, &decorations, theme);
    let mut guides = Vec::new();
    if options.indent_guides {
        guides = indent_paint::guide_lines(state, &layout, character_width);
    }
    let gutter_marks = gutter_marks(&layout, &decorations, theme, window);
    let mut jump_paint = JumpPaint::default();
    if let Some(session) = jump {
        jump_paint = jump_paint::build(session, &layout, theme, character_width, window);
    }
    let frame = Frame {
        bounds,
        companion: None,
        label: None,
        rows: painted_rows,
        gutter_width,
        selections,
        range_backgrounds,
        guides,
        decoration_underlines,
        gutter_marks,
        line_ends,
        cursors,
        underlines,
        vim,
        jump: jump_paint,
        minimap: None,
        theme: theme.clone(),
        prepaint_took: std::time::Duration::ZERO,
    };
    (layout, frame)
}

/// The blocks that have a key, with the display rows each covers.
fn keyed_blocks(blocks: &[PlacedBlock], map: &BlockMap) -> Vec<KeyedBlock> {
    let mut keyed = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let Some(key) = block.key else {
            continue;
        };
        let Some(rows) = map.rows_of(index) else {
            continue;
        };
        keyed.push(KeyedBlock { key: key.to_string(), rows });
    }
    keyed
}

/// Gives a frame the minimap, when the view has one and is wide enough to share, and records where
/// it is on the layout so the pointer can tell it from the text.
fn attach_minimap(
    layout: &mut Layout,
    frame: &mut Frame,
    state: &EditorState,
    width: Pixels,
    scroll_top: Pixels,
    furthest_scroll: Pixels,
) {
    let Some(strip) = minimap::strip_bounds(layout.bounds, width) else {
        return;
    };
    layout.minimap = Some(strip);
    let view_height = layout.bounds.size.height;
    frame.minimap = Some(minimap::build(state, strip, scroll_top, furthest_scroll, view_height, &frame.theme));
}

/// How opaque a tone is as a background behind text: the words a diff changed stand out from the rest.
fn background_opacity(tone: Tone) -> f32 {
    match tone {
        Tone::AddedWord | Tone::DeletedWord => WORD_OPACITY,
        _ => BACKGROUND_OPACITY,
    }
}

/// How opaque a tone is behind a whole row of a block: fillers are barely there.
fn block_opacity(tone: Tone) -> f32 {
    match tone {
        Tone::Filler => FILLER_OPACITY,
        _ => BLOCK_OPACITY,
    }
}

/// The tint of each buffer row a line decoration covers, such as the lines of a diff hunk.
fn line_tints(decorations: &[Placed], theme: &EditorTheme) -> HashMap<usize, Hsla> {
    let mut tints = HashMap::new();
    for placed in decorations {
        let DecorationKind::Line { tone } = placed.kind else {
            continue;
        };
        let color = theme.tone(*tone).opacity(BLOCK_OPACITY);
        for row in placed.start.row..=placed.end.row {
            tints.insert(row, color);
        }
    }
    tints
}

/// The strongly tinted stretches of one row of a block, where its emphasis marks them.
fn block_emphasis(
    block: &PlacedBlock,
    line: usize,
    display: &DisplayLine,
    shaped: &ShapedLine,
    text_left: Pixels,
    top: Pixels,
    theme: &EditorTheme,
) -> Vec<(Bounds<Pixels>, Hsla)> {
    let tone = match block.tone {
        Some(Tone::Deleted) => Tone::DeletedWord,
        Some(Tone::Added) => Tone::AddedWord,
        _ => return Vec::new(),
    };
    let color = theme.tone(tone).opacity(WORD_OPACITY);
    let marked = block.emphasis.iter().filter(|emphasis| emphasis.line == line);
    marked
        .map(|emphasis| {
            let left = text_left + shaped.x_for_index(display.range_start_offset(emphasis.start));
            let right = text_left + shaped.x_for_index(display.range_end_offset(emphasis.end));
            (Bounds::new(point(left, top), size(right - left, LINE_HEIGHT)), color)
        })
        .collect()
}

/// A buffer line laid out with the inlays on it, which must be ordered by column.
fn line_with_inlays(line: &str, inlays: &[(usize, &str, Tone)]) -> DisplayLine {
    let texts: Vec<InlayText> = inlays.iter().map(|(column, text, _)| InlayText { column: *column, text }).collect();
    DisplayLine::with_inlays(line, &texts)
}

/// The backgrounds and the lines under text that highlight decorations ask for.
fn range_decorations(
    layout: &Layout,
    decorations: &[Placed],
    theme: &EditorTheme,
) -> (Vec<(Bounds<Pixels>, Hsla)>, Vec<DecorationUnderline>) {
    let mut backgrounds = Vec::new();
    let mut underlines = Vec::new();
    for placed in decorations {
        let DecorationKind::Highlight { background, underline } = placed.kind else {
            continue;
        };
        if placed.start == placed.end {
            continue;
        }
        let spans = span_bounds(layout, placed.start, placed.end, px(0.0));
        if let Some(tone) = background {
            let color = background_color(theme, *tone);
            backgrounds.extend(spans.iter().map(|span| (*span, color)));
        }
        let Some(underline) = underline else {
            continue;
        };
        let wavy = underline.style == UnderlineKind::Squiggle;
        let height = if wavy { DECORATION_UNDERLINE_THICKNESS * 3.0 } else { DECORATION_UNDERLINE_THICKNESS };
        for span in &spans {
            let origin = point(span.left(), span.top() + LINE_HEIGHT - height - px(1.0));
            underlines.push(DecorationUnderline {
                origin,
                width: span.size.width,
                wavy,
                color: theme.tone(underline.tone),
            });
        }
    }
    (backgrounds, underlines)
}

/// The colour a decoration's background is drawn in: the tone's, faded so the text stays readable.
/// An occurrence's is the theme's own, which is already a quiet background.
fn background_color(theme: &EditorTheme, tone: Tone) -> Hsla {
    if tone == Tone::Occurrence {
        return theme.tone(tone);
    }
    theme.tone(tone).opacity(background_opacity(tone))
}

/// The marks gutter decorations put beside the line numbers on the rows in view.
fn gutter_marks(layout: &Layout, decorations: &[Placed], theme: &EditorTheme, window: &mut Window) -> Vec<GutterPaint> {
    let mut marks = Vec::new();
    let left = layout.bounds.left();
    for placed in decorations {
        let DecorationKind::Gutter { mark, tone } = placed.kind else {
            continue;
        };
        let color = theme.tone(tone.unwrap_or(Tone::Info));
        let rows = match mark {
            GutterMark::Bar => placed.start.row..placed.end.row + 1,
            _ => placed.start.row..placed.start.row + 1,
        };
        for row in rows {
            let Some((_, top)) = layout.line_of(row) else {
                continue;
            };
            match mark {
                GutterMark::Bar => {
                    let bar = Bounds::new(point(left + GUTTER_BAR_INSET, top), size(GUTTER_BAR_WIDTH, LINE_HEIGHT));
                    marks.push(GutterPaint::Shape { bounds: bar, color, radius: px(0.0) });
                }
                GutterMark::Dot => {
                    let origin = point(left + GUTTER_BAR_INSET, top + (LINE_HEIGHT - GUTTER_DOT_SIZE) / 2.0);
                    let dot = Bounds::new(origin, size(GUTTER_DOT_SIZE, GUTTER_DOT_SIZE));
                    marks.push(GutterPaint::Shape { bounds: dot, color, radius: GUTTER_DOT_SIZE / 2.0 });
                }
                GutterMark::Notch => {
                    let notch = Bounds::new(
                        point(left + GUTTER_BAR_INSET, top - GUTTER_NOTCH_HEIGHT / 2.0),
                        size(GUTTER_NOTCH_WIDTH, GUTTER_NOTCH_HEIGHT),
                    );
                    marks.push(GutterPaint::Shape { bounds: notch, color, radius: px(0.0) });
                }
                GutterMark::Glyph(character) => {
                    let shaped = shape_plain(window, &character.to_string(), color);
                    let origin = point(left + (GUTTER_PADDING - shaped.width) / 2.0, top);
                    marks.push(GutterPaint::Glyph { shaped, origin });
                }
            }
        }
    }
    marks
}

/// Where a cursor is drawn, or none while its row is scrolled out of view.
pub(super) fn cursor_bounds(layout: &Layout, head: Position) -> Option<Bounds<Pixels>> {
    let (line, top) = layout.line_of(head.row)?;
    let x = layout.text_left + line.shaped.x_for_index(line.display.offset_of(head.column));
    Some(Bounds::new(point(x, top), size(CURSOR_WIDTH, LINE_HEIGHT)))
}

/// A thin line along the bottom of each visible row a range covers.
fn underline_bounds(layout: &Layout, start: Position, end: Position) -> Vec<Bounds<Pixels>> {
    let spans = span_bounds(layout, start, end, px(0.0));
    let line_bottom = LINE_HEIGHT - UNDERLINE_HEIGHT;
    spans
        .iter()
        .map(|span| Bounds::new(point(span.left(), span.top() + line_bottom), size(span.size.width, UNDERLINE_HEIGHT)))
        .collect()
}

/// One rectangle per visible row a range covers, as tall as a line. A row the range runs past
/// the end of is widened by `line_ending_width`. A range starts after the inlays at its first
/// column and takes in the ones inside it.
pub(super) fn span_bounds(
    layout: &Layout,
    start: Position,
    end: Position,
    line_ending_width: Pixels,
) -> Vec<Bounds<Pixels>> {
    let mut spans = Vec::new();
    for (index, visible) in layout.rows.iter().enumerate() {
        let VisibleRow::Text(line) = visible else {
            continue;
        };
        if line.row < start.row || line.row > end.row {
            continue;
        }
        let runs_past_end = line.row != end.row;
        let left_offset = if line.row == start.row { line.display.range_start_offset(start.column) } else { 0 };
        let right_offset =
            if runs_past_end { line.display.text.len() } else { line.display.range_end_offset(end.column) };
        let left = layout.text_left + line.shaped.x_for_index(left_offset);
        let mut right = layout.text_left + line.shaped.x_for_index(right_offset);
        if runs_past_end {
            right += line_ending_width;
        }
        spans.push(Bounds::new(point(left, layout.top_of_index(index)), size(right - left, LINE_HEIGHT)));
    }
    spans
}

/// How wide a line of text is in the editor's font at the size popovers use.
pub(super) fn measure_text_width(window: &mut Window, text: &str) -> Pixels {
    let plain = HighlightStyle { color: Hsla::default(), bold: false, italic: false };
    let run = text_run(text.len(), plain, None);
    let size = px(13.0);
    window.text_system().shape_line(SharedString::from(text.to_string()), size, &[run], None).width
}

/// Shapes one line of text in the editor's font, in a single colour.
pub(super) fn shape_plain(window: &mut Window, text: &str, color: Hsla) -> ShapedLine {
    let plain = HighlightStyle { color, bold: false, italic: false };
    shape_runs(window, text, &[text_run(text.len(), plain, None)])
}

/// Like `shape_plain`, in italics.
fn shape_italic(window: &mut Window, text: &str, color: Hsla) -> ShapedLine {
    let italic = HighlightStyle { color, bold: false, italic: true };
    shape_runs(window, text, &[text_run(text.len(), italic, None)])
}

/// Shapes one line of text in the editor's font, in the colours of its runs, which must add up
/// to the length of the text.
fn shape_runs(window: &mut Window, text: &str, runs: &[TextRun]) -> ShapedLine {
    window.text_system().shape_line(SharedString::from(text.to_string()), FONT_SIZE, runs, None)
}

/// A run of `length` bytes painted in a style, on a background if it has one.
fn text_run(length: usize, style: HighlightStyle, background: Option<Hsla>) -> TextRun {
    let mut run_font = editor_font();
    if style.bold {
        run_font = run_font.bold();
    }
    if style.italic {
        run_font = run_font.italic();
    }
    TextRun {
        len: length,
        font: run_font,
        color: style.color,
        background_color: background,
        underline: None,
        strikethrough: None,
    }
}

/// The byte ranges of a row's drawn text that its syntax highlights colour. Highlights are in
/// columns of the buffer line, so a tab before one is already accounted for by the display line.
fn syntax_segments(
    display: &DisplayLine,
    spans: &[HighlightSpan],
    theme: &EditorTheme,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let mut segments = Vec::with_capacity(spans.len());
    let mut painted = 0;
    for span in spans {
        let start = display.range_start_offset(span.start_column).max(painted);
        let end = display.range_end_offset(span.end_column);
        if end <= start {
            continue;
        }
        if let Some(style) = theme.style_of(span.id) {
            segments.push((start..end, style));
        }
        painted = end;
    }
    segments
}

/// The runs a row is painted in: each highlighted stretch in its colour, each inlay in its
/// tone on a faint background, and the text between in the foreground.
fn text_runs(
    display: &DisplayLine,
    spans: &[HighlightSpan],
    inlay_tones: &[Tone],
    theme: &EditorTheme,
) -> Vec<TextRun> {
    let plain = HighlightStyle { color: theme.foreground, bold: false, italic: false };
    let segments = syntax_segments(display, spans, theme);
    let inlays = display.inlay_ranges();
    let mut boundaries = vec![0, display.text.len()];
    boundaries.extend(segments.iter().flat_map(|(range, _)| [range.start, range.end]));
    boundaries.extend(inlays.iter().flat_map(|range| [range.start, range.end]));
    boundaries.sort_unstable();
    boundaries.dedup();
    let mut runs = Vec::with_capacity(boundaries.len());
    for pair in boundaries.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let inlay = inlays.iter().position(|range| range.start <= start && start < range.end);
        if let Some(index) = inlay {
            let color = theme.tone(inlay_tones.get(index).copied().unwrap_or(Tone::Inlay));
            let style = HighlightStyle { color, bold: false, italic: false };
            runs.push(text_run(end - start, style, Some(color.opacity(BLOCK_OPACITY))));
            continue;
        }
        let segment = segments.iter().find(|(range, _)| range.start <= start && start < range.end);
        let style = segment.map(|(_, style)| *style).unwrap_or(plain);
        runs.push(text_run(end - start, style, None));
    }
    if runs.is_empty() {
        runs.push(text_run(0, plain, None));
    }
    runs
}

/// The editor's monospace font.
fn editor_font() -> Font {
    font(FONT_FAMILY)
}
