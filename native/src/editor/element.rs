//! The GPUI element that paints the editor. Like Zed's `EditorElement`, it is one element
//! for the whole viewport rather than one per line: each frame it works out which rows the
//! scroll offset makes visible, shapes only those, and paints them. GPUI's text system keeps
//! shaped lines from the previous frame, so rows that did not change are not shaped again.

use std::collections::HashSet;

use svelte_gpui::gpui::{
    App, Bounds, ContentMask, Element, ElementId, ElementInputHandler, Entity, Font, GlobalElementId, Hsla,
    InspectorElementId, IntoElement, LayoutId, Pixels, ShapedLine, SharedString, Style, TextRun, Window, fill, font,
    point, px, relative, size,
};

use super::Editor;
use super::theme::{EditorTheme, HighlightStyle};
use editor_core::display::DisplayLine;
use editor_core::syntax::HighlightSpan;
use editor_core::{EditorState, Position, Selection};

pub const FONT_FAMILY: &str = "DejaVu Sans Mono";
pub const FONT_SIZE: Pixels = px(14.0);
pub const LINE_HEIGHT: Pixels = px(21.0);
/// Space on each side of the line numbers.
const GUTTER_PADDING: Pixels = px(16.0);
const CURSOR_WIDTH: Pixels = px(2.0);
/// How wide a selected line ending is drawn.
const LINE_ENDING_WIDTH: Pixels = px(7.0);

const UNDERLINE_HEIGHT: Pixels = px(1.5);

/// What the last frame drew, kept on the editor so the pointer can be mapped to a position
/// and the cursor kept in view.
pub struct Layout {
    pub bounds: Bounds<Pixels>,
    /// Where the text starts, right of the gutter.
    pub text_left: Pixels,
    /// The first row drawn, and the y of its top, which is above `bounds` while it is
    /// scrolled partly out.
    pub first_row: usize,
    pub first_row_top: Pixels,
    /// The rows drawn, from `first_row` on.
    pub lines: Vec<VisibleLine>,
}

pub struct VisibleLine {
    pub display: DisplayLine,
    pub shaped: ShapedLine,
}

impl Layout {
    /// How many whole rows fit in the viewport.
    pub fn rows_in_view(&self) -> usize {
        (self.bounds.size.height / LINE_HEIGHT).floor().max(1.0) as usize
    }

    /// The buffer position nearest a point in the window.
    pub fn position_for_point(&self, point: svelte_gpui::gpui::Point<Pixels>) -> Position {
        let rows_down = ((point.y - self.first_row_top) / LINE_HEIGHT).floor().max(0.0) as usize;
        let row = self.first_row + rows_down;
        let Some(line) = self.lines.get(rows_down) else {
            return Position { row, column: usize::MAX };
        };
        let offset = line.shaped.closest_index_for_x(point.x - self.text_left);
        Position { row, column: line.display.column_at(offset) }
    }
}

pub struct EditorElement {
    pub editor: Entity<Editor>,
}

/// One row as this frame paints it.
struct PaintedRow {
    top: Pixels,
    number: ShapedLine,
    number_left: Pixels,
    text: ShapedLine,
    is_cursor_row: bool,
}

pub struct Frame {
    rows: Vec<PaintedRow>,
    gutter_width: Pixels,
    /// Behind the text: the parts of selections in view.
    highlights: Vec<Bounds<Pixels>>,
    cursors: Vec<Bounds<Pixels>>,
    /// Under the text an input method is composing.
    underlines: Vec<Bounds<Pixels>>,
    /// The colours this frame is painted with.
    theme: EditorTheme,
}

impl Frame {
    /// What is drawn for a view that shows no document: the background and nothing else.
    fn empty(theme: EditorTheme) -> Frame {
        Frame {
            theme,
            rows: Vec::new(),
            gutter_width: px(0.0),
            highlights: Vec::new(),
            cursors: Vec::new(),
            underlines: Vec::new(),
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

    /// Shapes the visible rows, works out where the selections and cursors in view are drawn,
    /// and records the layout on the editor.
    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Frame {
        let editor = self.editor.read(cx);
        let scroll_top = editor.scroll_top;
        let theme = editor.theme.clone();
        let Some((layout, frame)) = editor.read(|state| build_frame(state, scroll_top, bounds, window, &theme)) else {
            return Frame::empty(theme);
        };
        self.editor.update(cx, |editor, _| editor.layout = Some(layout));
        frame
    }

    /// Paints the background, the cursors' lines, the selections, the gutter, the text and the cursors.
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
        let focus = self.editor.read(cx).focus.clone();
        let focused = focus.is_focused(window);
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.editor.clone()), cx);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            let theme = &frame.theme;
            window.paint_quad(fill(bounds, theme.background));
            for row in frame.rows.iter().filter(|row| row.is_cursor_row) {
                let line = Bounds::new(point(bounds.left(), row.top), size(bounds.size.width, LINE_HEIGHT));
                window.paint_quad(fill(line, theme.current_line));
            }
            for highlight in &frame.highlights {
                window.paint_quad(fill(*highlight, theme.selection));
            }
            let text_left = bounds.left() + frame.gutter_width;
            for row in &frame.rows {
                let _ = row.number.paint(point(row.number_left, row.top), LINE_HEIGHT, window, cx);
                let _ = row.text.paint(point(text_left, row.top), LINE_HEIGHT, window, cx);
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
        });
    }
}

/// Shapes the rows in view, coloured by their syntax, and works out where the selections and
/// cursors are drawn, for a state scrolled to `scroll_top` in a box of `bounds`. Also gives the
/// layout the pointer is mapped through.
fn build_frame(
    state: &EditorState,
    scroll_top: Pixels,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    theme: &EditorTheme,
) -> (Layout, Frame) {
    let line_count = state.buffer().line_count();
    let digits = line_count.max(1).to_string().len();
    let digit_width = shape_plain(window, &"0".repeat(digits), theme.line_number).width;
    let gutter_width = digit_width + GUTTER_PADDING * 2.0;
    let text_left = bounds.left() + gutter_width;

    let first_row = (scroll_top / LINE_HEIGHT).floor() as usize;
    let first_row_top = bounds.top() - (scroll_top - LINE_HEIGHT * first_row as f32);
    let rows_drawn = (bounds.size.height / LINE_HEIGHT).ceil() as usize + 1;
    let end_row = (first_row + rows_drawn).min(line_count);
    let visible_selections = state.selections().in_rows(first_row, end_row);
    let cursor_rows: HashSet<usize> = visible_selections
        .iter()
        .filter(|selection| selection.is_empty())
        .map(|selection| selection.head.row)
        .collect();

    let highlights = state.highlights(first_row..end_row);
    let mut lines = Vec::with_capacity(end_row.saturating_sub(first_row));
    let mut rows = Vec::with_capacity(lines.capacity());
    for row in first_row..end_row {
        let display = DisplayLine::new(&state.buffer().line(row));
        let is_cursor_row = cursor_rows.contains(&row);
        let number_color = if is_cursor_row { theme.current_line_number } else { theme.line_number };
        let number = shape_plain(window, &(row + 1).to_string(), number_color);
        let runs = text_runs(&display, &highlights[row - first_row], theme);
        let text = shape_runs(window, &display.text, &runs);
        rows.push(PaintedRow {
            top: first_row_top + LINE_HEIGHT * (row - first_row) as f32,
            number_left: bounds.left() + GUTTER_PADDING + digit_width - number.width,
            number,
            text: text.clone(),
            is_cursor_row,
        });
        lines.push(VisibleLine { display, shaped: text });
    }

    let layout = Layout { bounds, text_left, first_row, first_row_top, lines };
    let selections = visible_selections.iter().flat_map(|selection| selection_bounds(&layout, selection)).collect();
    let underlines = state.marked_range().map(|(start, end)| underline_bounds(&layout, start, end)).unwrap_or_default();
    let cursors = visible_selections.iter().filter_map(|selection| cursor_bounds(&layout, selection.head)).collect();
    (layout, Frame { rows, gutter_width, highlights: selections, cursors, underlines, theme: theme.clone() })
}

/// Where a cursor is drawn, or none while its row is scrolled out of view.
pub(super) fn cursor_bounds(layout: &Layout, head: Position) -> Option<Bounds<Pixels>> {
    let x = x_for(layout, head)?;
    let top = layout.first_row_top + LINE_HEIGHT * (head.row - layout.first_row) as f32;
    Some(Bounds::new(point(x, top), size(CURSOR_WIDTH, LINE_HEIGHT)))
}

/// The x where a position is drawn, or none while its row is out of view.
fn x_for(layout: &Layout, position: Position) -> Option<Pixels> {
    let line = layout.lines.get(position.row.checked_sub(layout.first_row)?)?;
    Some(layout.text_left + line.shaped.x_for_index(line.display.offset_of(position.column)))
}

/// The highlight behind a selection, one rectangle per visible row it covers. A row the
/// selection runs past the end of gets a little extra width, standing for its line ending.
fn selection_bounds(layout: &Layout, selection: &Selection) -> Vec<Bounds<Pixels>> {
    if selection.is_empty() {
        return Vec::new();
    }
    span_bounds(layout, selection.start(), selection.end(), LINE_ENDING_WIDTH)
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
/// the end of is widened by `line_ending_width`.
fn span_bounds(layout: &Layout, start: Position, end: Position, line_ending_width: Pixels) -> Vec<Bounds<Pixels>> {
    let first = start.row.max(layout.first_row);
    let last = end.row.min(layout.first_row + layout.lines.len().saturating_sub(1));
    let mut spans = Vec::new();
    for row in first..=last {
        let start_column = if row == start.row { start.column } else { 0 };
        let runs_past_end = row != end.row;
        let end_column = if runs_past_end { usize::MAX } else { end.column };
        let Some(left) = x_for(layout, Position { row, column: start_column }) else {
            continue;
        };
        let Some(mut right) = x_for(layout, Position { row, column: end_column }) else {
            continue;
        };
        if runs_past_end {
            right += line_ending_width;
        }
        let top = layout.first_row_top + LINE_HEIGHT * (row - layout.first_row) as f32;
        spans.push(Bounds::new(point(left, top), size(right - left, LINE_HEIGHT)));
    }
    spans
}

/// Shapes one line of text in the editor's font, in a single colour.
fn shape_plain(window: &mut Window, text: &str, color: Hsla) -> ShapedLine {
    let plain = HighlightStyle { color, bold: false, italic: false };
    shape_runs(window, text, &[text_run(text.len(), plain)])
}

/// Shapes one line of text in the editor's font, in the colours of its runs, which must add up
/// to the length of the text.
fn shape_runs(window: &mut Window, text: &str, runs: &[TextRun]) -> ShapedLine {
    window.text_system().shape_line(SharedString::from(text.to_string()), FONT_SIZE, runs, None)
}

/// A run of `length` bytes painted in a style.
fn text_run(length: usize, style: HighlightStyle) -> TextRun {
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
        background_color: None,
        underline: None,
        strikethrough: None,
    }
}

/// The runs a row is painted in: each highlighted stretch in its colour and the text between
/// them in the foreground. Highlights are in columns of the buffer line, so a tab before one is
/// already accounted for by the display line.
fn text_runs(display: &DisplayLine, spans: &[HighlightSpan], theme: &EditorTheme) -> Vec<TextRun> {
    let plain = HighlightStyle { color: theme.foreground, bold: false, italic: false };
    let mut runs = Vec::with_capacity(spans.len() * 2 + 1);
    let mut painted = 0;
    for span in spans {
        let start = display.offset_of(span.start_column).max(painted);
        let end = display.offset_of(span.end_column);
        if end <= start {
            continue;
        }
        if start > painted {
            runs.push(text_run(start - painted, plain));
        }
        runs.push(text_run(end - start, theme.style_of(span.id).unwrap_or(plain)));
        painted = end;
    }
    if painted < display.text.len() || runs.is_empty() {
        runs.push(text_run(display.text.len() - painted, plain));
    }
    runs
}

/// The editor's monospace font.
fn editor_font() -> Font {
    font(FONT_FAMILY)
}
