//! The GPUI element that paints the editor. Like Zed's `EditorElement`, it is one element
//! for the whole viewport rather than one per line: each frame it works out which rows the
//! scroll offset makes visible, shapes only those, and paints them. GPUI's text system keeps
//! shaped lines from the previous frame, so rows that did not change are not shaped again.

use svelte_gpui::gpui::{
    App, Bounds, ContentMask, Element, ElementId, Entity, Font, GlobalElementId, Hsla, InspectorElementId, IntoElement,
    LayoutId, Pixels, ShapedLine, SharedString, Style, TextRun, Window, fill, font, point, px, relative, rgb, size,
};

use super::Editor;
use super::buffer::Position;
use super::display::DisplayLine;

pub const FONT_FAMILY: &str = "DejaVu Sans Mono";
pub const FONT_SIZE: Pixels = px(14.0);
pub const LINE_HEIGHT: Pixels = px(21.0);
/// Space on each side of the line numbers.
const GUTTER_PADDING: Pixels = px(16.0);
const CURSOR_WIDTH: Pixels = px(2.0);

const BACKGROUND: u32 = 0x18181b;
const CURRENT_LINE: u32 = 0x222226;
const TEXT: u32 = 0xe4e4e7;
const LINE_NUMBER: u32 = 0x52525b;
const CURRENT_LINE_NUMBER: u32 = 0xa1a1aa;
const CURSOR: u32 = 0xf97316;

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
    cursor: Option<Bounds<Pixels>>,
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

    /// Shapes the visible rows and records the layout on the editor.
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
        let line_count = editor.buffer.line_count();
        let cursor = editor.cursor;
        let scroll_top = editor.scroll_top;

        let digits = line_count.max(1).to_string().len();
        let digit_width = shape(window, &"0".repeat(digits), LINE_NUMBER).width;
        let gutter_width = digit_width + GUTTER_PADDING * 2.0;
        let text_left = bounds.left() + gutter_width;

        let first_row = (scroll_top / LINE_HEIGHT).floor() as usize;
        let first_row_top = bounds.top() - (scroll_top - LINE_HEIGHT * first_row as f32);
        let rows_drawn = (bounds.size.height / LINE_HEIGHT).ceil() as usize + 1;
        let end_row = (first_row + rows_drawn).min(line_count);

        let mut lines = Vec::with_capacity(end_row.saturating_sub(first_row));
        let mut rows = Vec::with_capacity(lines.capacity());
        for row in first_row..end_row {
            let display = DisplayLine::new(&editor.buffer.line(row));
            let is_cursor_row = row == cursor.row;
            let number_color = if is_cursor_row { CURRENT_LINE_NUMBER } else { LINE_NUMBER };
            let number = shape(window, &(row + 1).to_string(), number_color);
            let text = shape(window, &display.text, TEXT);
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
        let cursor_bounds = cursor_bounds(&layout, cursor);
        self.editor.update(cx, |editor, _| editor.layout = Some(layout));
        Frame { rows, gutter_width, cursor: cursor_bounds }
    }

    /// Paints the background, the cursor's line, the gutter, the text and the cursor.
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
        let focused = self.editor.read(cx).focus.is_focused(window);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            window.paint_quad(fill(bounds, color(BACKGROUND)));
            let text_left = bounds.left() + frame.gutter_width;
            for row in &frame.rows {
                if row.is_cursor_row {
                    let line = Bounds::new(point(bounds.left(), row.top), size(bounds.size.width, LINE_HEIGHT));
                    window.paint_quad(fill(line, color(CURRENT_LINE)));
                }
                let _ = row.number.paint(point(row.number_left, row.top), LINE_HEIGHT, window, cx);
                let _ = row.text.paint(point(text_left, row.top), LINE_HEIGHT, window, cx);
            }
            if let Some(cursor) = frame.cursor {
                let mut cursor_color = color(CURSOR);
                if !focused {
                    cursor_color.a = 0.4;
                }
                window.paint_quad(fill(cursor, cursor_color));
            }
        });
    }
}

/// Where the cursor is drawn, or none while its row is scrolled out of view.
fn cursor_bounds(layout: &Layout, cursor: Position) -> Option<Bounds<Pixels>> {
    let index = cursor.row.checked_sub(layout.first_row)?;
    let line = layout.lines.get(index)?;
    let x = layout.text_left + line.shaped.x_for_index(line.display.offset_of(cursor.column));
    let top = layout.first_row_top + LINE_HEIGHT * index as f32;
    Some(Bounds::new(point(x, top), size(CURSOR_WIDTH, LINE_HEIGHT)))
}

/// Shapes one line of text in the editor's font, in a single colour.
fn shape(window: &mut Window, text: &str, color_value: u32) -> ShapedLine {
    let run = TextRun {
        len: text.len(),
        font: editor_font(),
        color: color(color_value),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window.text_system().shape_line(SharedString::from(text.to_string()), FONT_SIZE, &[run], None)
}

/// The editor's monospace font.
fn editor_font() -> Font {
    font(FONT_FAMILY)
}

/// A colour from its `0xRRGGBB` value.
fn color(value: u32) -> Hsla {
    rgb(value).into()
}
