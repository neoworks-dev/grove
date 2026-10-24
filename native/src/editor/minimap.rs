//! The minimap: a narrow strip on the right edge of the editor that shows the whole buffer in
//! miniature, with a band over the rows that are on screen.
//!
//! Nothing here shapes text. Each line is drawn as small coloured blocks, one per run of
//! characters that share a syntax colour, a column wide and a couple of pixels tall, so a large
//! file costs about as much as a small one: only the lines the strip has room for are looked at.
//! A file too long for the strip is scrolled inside it in proportion to the editor's own scroll.
//!
//! The geometry and the blocks of a line are plain numbers, so they are tested without a window.
//! Pointer input does not arrive here as GPUI events: the app lays a view over the strip and
//! forwards what it hears to the `minimapScroll` method.

use std::ops::Range;

use serde_json::Value;
use svelte_gpui::CommandError;
use svelte_gpui::gpui::{Bounds, Context, Pixels, Window, fill, point, px, size};

use super::Editor;
use super::element::LINE_HEIGHT;
use super::theme::EditorTheme;
use editor_core::EditorState;
use editor_core::syntax::{HighlightId, HighlightSpan};

/// How tall a line is in the strip, blocks and the space under them.
const ROW_HEIGHT: f32 = 3.0;
/// How tall the blocks of a line are.
const BLOCK_HEIGHT: f32 = 2.0;
/// How wide a column of text is.
const COLUMN_WIDTH: f32 = 1.0;
/// How many columns a tab takes up.
const TAB_COLUMNS: usize = 4;
/// Space between the strip's left edge and the text, and the text and its right edge.
const PADDING: f32 = 6.0;
/// How opaque the text no syntax colours is, against the syntax colours' full strength.
const PLAIN_OPACITY: f32 = 0.45;
/// How opaque the band over the rows in view is, and its edges.
const BAND_OPACITY: f32 = 0.10;
const BAND_EDGE_OPACITY: f32 = 0.22;
/// How opaque the strip's background is over the text under it.
const BACKGROUND_OPACITY: f32 = 0.8;
/// How opaque the line between the text and the strip is.
const DIVIDER_OPACITY: f32 = 0.10;

/// A run of characters on one line that are drawn as one block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Block {
    pub start_column: usize,
    pub end_column: usize,
    /// The syntax colour, or none for text the syntax leaves in the foreground colour.
    pub id: Option<HighlightId>,
}

/// The blocks of a line, in columns counted from its left edge with tabs spread out, stopping at
/// `max_columns`. White space is never drawn, and a block ends where the colour changes.
pub(super) fn line_blocks(line: &str, spans: &[HighlightSpan], max_columns: usize) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut column = 0;
    let mut next_span = 0;
    for (character_column, character) in line.chars().enumerate() {
        if column >= max_columns {
            break;
        }
        if character == '\t' {
            column = (column / TAB_COLUMNS + 1) * TAB_COLUMNS;
            continue;
        }
        if character.is_whitespace() {
            column += 1;
            continue;
        }
        while next_span < spans.len() && spans[next_span].end_column <= character_column {
            next_span += 1;
        }
        let id = span_id_at(spans, next_span, character_column);
        column += 1;
        let continues = blocks.last().is_some_and(|last| last.end_column == column - 1 && last.id == id);
        if continues {
            let last = blocks.len() - 1;
            blocks[last].end_column = column;
            continue;
        }
        blocks.push(Block { start_column: column - 1, end_column: column, id });
    }
    blocks
}

/// The highlight that covers a character column, looking from the span at `from` on.
fn span_id_at(spans: &[HighlightSpan], from: usize, character_column: usize) -> Option<HighlightId> {
    let span = spans.get(from)?;
    if span.start_column > character_column {
        return None;
    }
    Some(span.id)
}

/// Where the lines of a buffer are in the strip, and how far the strip is scrolled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Geometry {
    strip_height: f32,
    line_count: usize,
    /// How far the editor is scrolled, from 0 at the top to 1 at its furthest.
    scroll_fraction: f32,
}

impl Geometry {
    /// The geometry of a buffer of `line_count` lines in a strip `strip_height` tall.
    pub fn new(line_count: usize, strip_height: f32, scroll_fraction: f32) -> Self {
        Geometry { strip_height, line_count, scroll_fraction: scroll_fraction.clamp(0.0, 1.0) }
    }

    /// How tall all the lines are together.
    fn content_height(&self) -> f32 {
        self.line_count as f32 * ROW_HEIGHT
    }

    /// How far the lines are scrolled up inside the strip: nothing while they all fit, and else
    /// in proportion to the editor's scroll, so its top shows the first line and its end the last.
    pub fn offset(&self) -> f32 {
        let overflow = self.content_height() - self.strip_height;
        if overflow <= 0.0 {
            return 0.0;
        }
        overflow * self.scroll_fraction
    }

    /// The y in the strip of the top of a line, which may be a fraction of one.
    pub fn y_of_row(&self, row: f32) -> f32 {
        row * ROW_HEIGHT - self.offset()
    }

    /// The lines the strip has room for, which are the ones drawn.
    pub fn rows_in_strip(&self) -> Range<usize> {
        let first = (self.offset() / ROW_HEIGHT).floor() as usize;
        let last = ((self.offset() + self.strip_height) / ROW_HEIGHT).ceil() as usize;
        first.min(self.line_count)..last.min(self.line_count)
    }
}

/// How far an editor is scrolled, from 0 to 1, given its furthest scroll.
pub(super) fn scroll_fraction(scroll_top: f32, furthest: f32) -> f32 {
    if furthest <= 0.0 {
        return 0.0;
    }
    (scroll_top / furthest).clamp(0.0, 1.0)
}

/// How the editor is laid out for a click on the minimap to be turned into a scroll.
#[derive(Clone, Copy, Debug)]
pub(super) struct ClickLayout {
    pub line_count: usize,
    pub strip_height: f32,
    /// How many lines the editor shows at once.
    pub rows_in_view: f32,
    pub line_height: f32,
    /// The most the editor can scroll.
    pub furthest: f32,
}

/// The scroll offset after which the middle of the editor's view is at this y in the strip.
///
/// A buffer too long for the strip is panned inside it as the editor scrolls, so the line under the
/// pointer changes with the scroll. Taking the line under the pointer now and scrolling to it would
/// land short of the pointer and need many moves to catch up; this solves for the scroll at which
/// the band's middle ends up under it instead, so a drag follows the pointer.
pub(super) fn scroll_top_for_pointer(layout: &ClickLayout, y: f32) -> f32 {
    let furthest = layout.furthest.max(0.0);
    let half_view = layout.rows_in_view * ROW_HEIGHT / 2.0;
    let overflow = layout.line_count as f32 * ROW_HEIGHT - layout.strip_height;
    let band_travel = ROW_HEIGHT * furthest / layout.line_height - overflow;
    if overflow <= 0.0 || band_travel <= 0.0 {
        let row = y / ROW_HEIGHT;
        return ((row - layout.rows_in_view / 2.0) * layout.line_height).clamp(0.0, furthest);
    }
    let fraction = ((y - half_view) / band_travel).clamp(0.0, 1.0);
    fraction * furthest
}

/// The minimap of one frame, ready to paint.
pub struct MinimapPaint {
    strip: Bounds<Pixels>,
    /// The rows in view, as the strip shows them.
    band: Bounds<Pixels>,
    blocks: Vec<(Bounds<Pixels>, svelte_gpui::gpui::Hsla)>,
}

/// The strip's place at the right edge of the editor's `bounds`, or none while it is off or the
/// editor is too narrow to share.
pub fn strip_bounds(bounds: Bounds<Pixels>, width: Pixels) -> Option<Bounds<Pixels>> {
    if width <= px(0.0) || bounds.size.width < width * 2.0 {
        return None;
    }
    let origin = point(bounds.right() - width, bounds.top());
    Some(Bounds::new(origin, size(width, bounds.size.height)))
}

/// Lays out the minimap of a document scrolled to `scroll_top`, in a `strip` of the window.
/// `furthest` is the most the editor can scroll, which the strip's own scroll follows.
pub fn build(
    state: &EditorState,
    strip: Bounds<Pixels>,
    scroll_top: Pixels,
    furthest: Pixels,
    view_height: Pixels,
    theme: &EditorTheme,
) -> MinimapPaint {
    let line_count = state.buffer().line_count();
    let fraction = scroll_fraction(f32::from(scroll_top), f32::from(furthest));
    let geometry = Geometry::new(line_count, f32::from(strip.size.height), fraction);
    let max_columns = ((f32::from(strip.size.width) - PADDING * 2.0) / COLUMN_WIDTH).max(0.0) as usize;
    let rows = geometry.rows_in_strip();
    let highlights = state.highlights(rows.clone());
    let mut blocks = Vec::new();
    for (index, row) in rows.clone().enumerate() {
        let top = strip.top() + px(geometry.y_of_row(row as f32));
        let line = state.buffer().line(row);
        for block in line_blocks(&line, &highlights[index], max_columns) {
            let left = strip.left() + px(PADDING + block.start_column as f32 * COLUMN_WIDTH);
            let width = px((block.end_column - block.start_column) as f32 * COLUMN_WIDTH);
            blocks.push((Bounds::new(point(left, top), size(width, px(BLOCK_HEIGHT))), block_color(block.id, theme)));
        }
    }
    let line_height = f32::from(LINE_HEIGHT);
    let band_top = geometry.y_of_row(f32::from(scroll_top) / line_height);
    let band_height = f32::from(view_height) / line_height * ROW_HEIGHT;
    let band = band_in_strip(strip, band_top, band_height);
    MinimapPaint { strip, band, blocks }
}

/// The band over the rows in view, kept inside the strip.
fn band_in_strip(strip: Bounds<Pixels>, top: f32, height: f32) -> Bounds<Pixels> {
    let strip_height = f32::from(strip.size.height);
    let clipped_top = top.clamp(0.0, strip_height);
    let clipped_bottom = (top + height).clamp(0.0, strip_height);
    Bounds::new(
        point(strip.left(), strip.top() + px(clipped_top)),
        size(strip.size.width, px((clipped_bottom - clipped_top).max(0.0))),
    )
}

/// The colour a block is drawn in: its syntax colour, or the foreground, quieter, for plain text.
fn block_color(id: Option<HighlightId>, theme: &EditorTheme) -> svelte_gpui::gpui::Hsla {
    let styled = id.and_then(|id| theme.style_of(id));
    match styled {
        Some(style) => style.color,
        None => theme.foreground.opacity(PLAIN_OPACITY),
    }
}

/// Paints the strip: its half-transparent background over whatever the text drew under it, the blocks, and the band.
pub fn paint(minimap: &MinimapPaint, theme: &EditorTheme, window: &mut Window) {
    window.paint_quad(fill(minimap.strip, theme.background.opacity(BACKGROUND_OPACITY)));
    let divider = Bounds::new(minimap.strip.origin, size(px(1.0), minimap.strip.size.height));
    window.paint_quad(fill(divider, theme.foreground.opacity(DIVIDER_OPACITY)));
    for (bounds, color) in &minimap.blocks {
        window.paint_quad(fill(*bounds, *color));
    }
    window.paint_quad(fill(minimap.band, theme.foreground.opacity(BAND_OPACITY)));
    let edge = size(minimap.band.size.width, px(1.0));
    window.paint_quad(fill(Bounds::new(minimap.band.origin, edge), theme.foreground.opacity(BAND_EDGE_OPACITY)));
    let bottom = point(minimap.band.left(), minimap.band.bottom() - px(1.0));
    window.paint_quad(fill(Bounds::new(bottom, edge), theme.foreground.opacity(BAND_EDGE_OPACITY)));
}

impl Editor {
    /// Sets the width of the minimap from the `minimap` prop; none or zero turns it off.
    pub(super) fn set_minimap_width(&mut self, value: &Value, cx: &mut Context<Self>) {
        let width = value.as_f64().unwrap_or(0.0).max(0.0);
        self.minimap_width = px(width as f32);
        cx.notify();
    }

    /// The `minimapScroll` method: scrolls so the row under a pointer at this y in the window,
    /// which the app saw press or drag over the strip, is in the middle of the editor.
    pub(super) fn minimap_scroll_from_app(
        &mut self,
        args: Value,
        cx: &mut Context<Self>,
    ) -> Result<Value, CommandError> {
        let Some(window_y) = args.get(0).and_then(Value::as_f64) else {
            return Err(CommandError::with_code("InvalidArguments", "minimapScroll takes the pointer's y"));
        };
        let Some(layout) = &self.layout else {
            return Ok(Value::Null);
        };
        let Some(strip) = layout.minimap else {
            return Ok(Value::Null);
        };
        let Some(line_count) = self.read(|state| state.buffer().line_count()) else {
            return Ok(Value::Null);
        };
        let line_height = f32::from(LINE_HEIGHT);
        let click = ClickLayout {
            line_count,
            strip_height: f32::from(strip.size.height),
            rows_in_view: f32::from(layout.bounds.size.height) / line_height,
            line_height,
            furthest: f32::from(self.furthest_scroll()),
        };
        let target = scroll_top_for_pointer(&click, window_y as f32 - f32::from(strip.top()));
        self.scroll_animation = None;
        self.set_scroll_top(px(target));
        self.hide_hover(cx);
        self.occurrences_may_have_changed(cx);
        self.refresh_search_marks(cx);
        self.scroll_group_to_here(cx);
        cx.notify();
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start_column: usize, end_column: usize, id: u8) -> HighlightSpan {
        HighlightSpan { start_column, end_column, id: HighlightId(id) }
    }

    #[test]
    fn white_space_is_left_out_and_a_colour_change_starts_a_block() {
        let spans = [span(0, 2, 3), span(3, 6, 5)];
        let blocks = line_blocks("fn main", &spans, 90);
        let found: Vec<_> = blocks.iter().map(|block| (block.start_column, block.end_column, block.id)).collect();
        assert_eq!(found, vec![(0, 2, Some(HighlightId(3))), (3, 6, Some(HighlightId(5))), (6, 7, None)]);
    }

    #[test]
    fn a_tab_moves_the_text_to_the_next_stop() {
        let blocks = line_blocks("\tx", &[], 90);
        assert_eq!(blocks, vec![Block { start_column: 4, end_column: 5, id: None }]);
    }

    #[test]
    fn a_long_line_stops_at_the_strips_width() {
        let blocks = line_blocks(&"x".repeat(200), &[], 40);
        assert_eq!(blocks, vec![Block { start_column: 0, end_column: 40, id: None }]);
    }

    #[test]
    fn a_short_buffer_sits_at_the_top_of_the_strip() {
        let geometry = Geometry::new(10, 300.0, 0.7);
        assert_eq!(geometry.offset(), 0.0);
        assert_eq!(geometry.rows_in_strip(), 0..10);
        assert_eq!(geometry.y_of_row(4.0), 12.0);
    }

    #[test]
    fn a_long_buffer_scrolls_inside_the_strip_with_the_editor() {
        let top = Geometry::new(1000, 300.0, 0.0);
        assert_eq!(top.rows_in_strip(), 0..100);
        let bottom = Geometry::new(1000, 300.0, 1.0);
        assert_eq!(bottom.rows_in_strip(), 900..1000);
        assert_eq!(bottom.y_of_row(999.0), 297.0);
    }

    /// Where the middle of the editor's view is in the strip once it is scrolled to `scroll_top`.
    fn band_middle(layout: &ClickLayout, scroll_top: f32) -> f32 {
        let fraction = scroll_fraction(scroll_top, layout.furthest);
        let geometry = Geometry::new(layout.line_count, layout.strip_height, fraction);
        let middle_row = scroll_top / layout.line_height + layout.rows_in_view / 2.0;
        geometry.y_of_row(middle_row)
    }

    fn long_buffer() -> ClickLayout {
        ClickLayout {
            line_count: 1000,
            strip_height: 300.0,
            rows_in_view: 40.0,
            line_height: 21.0,
            furthest: 999.0 * 21.0,
        }
    }

    #[test]
    fn a_click_on_a_short_buffer_puts_the_row_under_it_in_the_middle() {
        let layout = ClickLayout {
            line_count: 50,
            strip_height: 300.0,
            rows_in_view: 10.0,
            line_height: 21.0,
            furthest: 49.0 * 21.0,
        };
        // y 60 is row 20, so with ten rows in view the top row is 15.
        assert_eq!(scroll_top_for_pointer(&layout, 60.0), 15.0 * 21.0);
        assert_eq!(scroll_top_for_pointer(&layout, 0.0), 0.0);
        assert_eq!(scroll_top_for_pointer(&layout, 300.0), 49.0 * 21.0);
    }

    #[test]
    fn a_click_on_a_long_buffer_leaves_the_band_under_the_pointer() {
        let layout = long_buffer();
        for y in [90.0, 150.0, 240.0] {
            let scroll_top = scroll_top_for_pointer(&layout, y);
            assert!((band_middle(&layout, scroll_top) - y).abs() < 0.01, "y {y}");
        }
    }

    #[test]
    fn a_click_past_the_ends_goes_to_the_ends() {
        let layout = long_buffer();
        assert_eq!(scroll_top_for_pointer(&layout, 0.0), 0.0);
        assert_eq!(scroll_top_for_pointer(&layout, 10_000.0), layout.furthest);
    }

    #[test]
    fn the_scroll_fraction_stays_between_the_ends() {
        assert_eq!(scroll_fraction(50.0, 100.0), 0.5);
        assert_eq!(scroll_fraction(500.0, 100.0), 1.0);
        assert_eq!(scroll_fraction(10.0, 0.0), 0.0);
    }
}
