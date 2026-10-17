//! What vim mode adds to the editor's painting: a block or underline cursor in place of the bar,
//! selections that include the character under their head, and the line typed after `:`, `/`
//! and `?` along the bottom of the view.

use svelte_gpui::gpui::{Bounds, Hsla, Pixels, ShapedLine, Window, fill, point, px, size};

use super::element::{LINE_ENDING_WIDTH, LINE_HEIGHT, Layout, shape_plain, span_bounds};
use super::theme::EditorTheme;
use editor_core::{CursorShape, InputStatus, Position, Selection, SelectionStyle};

/// How tall the underline cursor is.
const UNDERLINE_CURSOR_HEIGHT: Pixels = px(2.0);
/// How opaque a block cursor is, which lets the character under it show through.
const BLOCK_CURSOR_OPACITY: f32 = 0.55;
/// The width of the caret in the command line.
const CARET_WIDTH: Pixels = px(2.0);

/// The line typed after `:`, `/` or `?`, shaped and placed.
pub struct CommandLinePaint {
    bar: Bounds<Pixels>,
    text: ShapedLine,
    caret: Bounds<Pixels>,
}

/// Everything vim mode adds to a frame.
#[derive(Default)]
pub struct VimPaint {
    /// Painted behind the text, so the character stays readable.
    pub block_cursors: Vec<Bounds<Pixels>>,
    pub command_line: Option<CommandLinePaint>,
}

/// The width of one character of the editor's font.
pub fn character_width(window: &mut Window, color: Hsla) -> Pixels {
    shape_plain(window, "0", color).width
}

/// The cursors a frame draws. A bar is painted over the text with the others in the first
/// list; a block goes behind it, in the second. The selections vim's visual mode paints are
/// in `selection_spans`.
pub fn cursor_bounds_for(
    layout: &Layout,
    selections: &[Selection],
    status: &InputStatus,
    character_width: Pixels,
) -> (Vec<Bounds<Pixels>>, Vec<Bounds<Pixels>>) {
    let mut over_text = Vec::new();
    let mut behind_text = Vec::new();
    for selection in selections {
        let Some(bounds) = cursor_in(layout, selection.head, status.cursor, character_width) else {
            continue;
        };
        match status.cursor {
            CursorShape::Block => behind_text.push(bounds),
            _ => over_text.push(bounds),
        }
    }
    (over_text, behind_text)
}

/// Where one cursor is drawn in the shape asked for, or none while its row is out of view.
fn cursor_in(layout: &Layout, head: Position, shape: CursorShape, character_width: Pixels) -> Option<Bounds<Pixels>> {
    let (line, top) = layout.line_of(head.row)?;
    let start = line.display.offset_of(head.column);
    let left = layout.text_left + line.shaped.x_for_index(start);
    if shape == CursorShape::Bar {
        return Some(Bounds::new(point(left, top), size(px(2.0), LINE_HEIGHT)));
    }
    let width = if start >= line.display.text.len() {
        character_width
    } else {
        let end = line.display.range_end_offset(head.column + 1);
        layout.text_left + line.shaped.x_for_index(end) - left
    };
    if shape == CursorShape::Block {
        return Some(Bounds::new(point(left, top), size(width, LINE_HEIGHT)));
    }
    let bottom = top + LINE_HEIGHT - UNDERLINE_CURSOR_HEIGHT;
    Some(Bounds::new(point(left, bottom), size(width, UNDERLINE_CURSOR_HEIGHT)))
}

/// The highlight behind a selection in the layer's style: up to the head, or including the
/// character under it, or whole lines.
pub fn selection_spans(layout: &Layout, selection: &Selection, style: SelectionStyle) -> Vec<Bounds<Pixels>> {
    let start = selection.start();
    let end = selection.end();
    match style {
        SelectionStyle::Exclusive => {
            if selection.is_empty() {
                return Vec::new();
            }
            span_bounds(layout, start, end, LINE_ENDING_WIDTH)
        }
        SelectionStyle::Inclusive => {
            let after_head = Position { row: end.row, column: end.column + 1 };
            let mut spans = span_bounds(layout, start, after_head, LINE_ENDING_WIDTH);
            for span in &mut spans {
                if span.size.width < px(1.0) {
                    span.size.width = LINE_ENDING_WIDTH;
                }
            }
            spans
        }
        SelectionStyle::Lines => {
            let first = Position { row: start.row, column: 0 };
            let last = Position { row: end.row, column: usize::MAX };
            span_bounds(layout, first, last, LINE_ENDING_WIDTH)
        }
    }
}

/// Shapes the command line along the bottom of the view, or none when none is being typed.
pub fn command_line(
    layout: &Layout,
    status: &InputStatus,
    theme: &EditorTheme,
    window: &mut Window,
) -> Option<CommandLinePaint> {
    let text = status.command_line.as_ref()?;
    let bounds = layout.bounds;
    let bar = Bounds::new(point(bounds.left(), bounds.bottom() - LINE_HEIGHT), size(bounds.size.width, LINE_HEIGHT));
    let shaped = shape_plain(window, text, theme.foreground);
    let caret_left = bounds.left() + px(8.0) + shaped.width;
    let caret = Bounds::new(point(caret_left, bar.top()), size(CARET_WIDTH, LINE_HEIGHT));
    Some(CommandLinePaint { bar, text: shaped, caret })
}

/// Paints the block cursors, which go behind the text so the character under one shows through.
pub fn paint_behind_text(paint: &VimPaint, theme: &EditorTheme, focused: bool, window: &mut Window) {
    let mut color = theme.cursor;
    color.a = if focused { BLOCK_CURSOR_OPACITY } else { 0.25 };
    for block in &paint.block_cursors {
        window.paint_quad(fill(*block, color));
    }
}

/// Paints the command line over the bottom row of the view.
pub fn paint_command_line(paint: &VimPaint, theme: &EditorTheme, window: &mut Window, cx: &mut svelte_gpui::gpui::App) {
    let Some(line) = &paint.command_line else {
        return;
    };
    window.paint_quad(fill(line.bar, theme.current_line));
    let border = Bounds::new(line.bar.origin, size(line.bar.size.width, px(1.0)));
    window.paint_quad(fill(border, theme.line_number));
    let origin = point(line.bar.left() + px(8.0), line.bar.top());
    let _ = line.text.paint(origin, LINE_HEIGHT, window, cx);
    window.paint_quad(fill(line.caret, theme.cursor));
}
