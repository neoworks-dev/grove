//! Indent guides as the view paints them: a thin vertical line at each indentation level of the
//! visible rows, with the cursor's scope in a brighter colour. Which guides a row has comes from
//! `editor_core::guides`; this places them on the screen.

use svelte_gpui::gpui::{Bounds, Pixels, Window, fill, point, px, size};

use super::element::{LINE_HEIGHT, Layout, VisibleRow};
use super::theme::EditorTheme;
use editor_core::{EditorState, guides::Guides};

/// How wide a guide is.
const GUIDE_WIDTH: Pixels = px(1.0);

/// One guide on one row.
pub struct GuideLine {
    bounds: Bounds<Pixels>,
    /// Whether it belongs to the scope around the cursor.
    active: bool,
}

/// The guides of the rows a frame draws, for the newest cursor's scope. A row's guides stand at
/// each indentation level's left edge, `character_width` times its columns from the text.
pub fn guide_lines(state: &EditorState, layout: &Layout, character_width: Pixels) -> Vec<GuideLine> {
    let Some(rows) = text_rows(layout) else {
        return Vec::new();
    };
    let style = state.buffer().indent();
    let cursor_row = state.selections().newest().head.row;
    let guides = Guides::compute(state.buffer(), rows, cursor_row, style);
    let level_width = character_width * style.columns() as f32;
    let mut lines = Vec::new();
    for (index, visible) in layout.rows.iter().enumerate() {
        let VisibleRow::Text(line) = visible else {
            continue;
        };
        let top = layout.top_of_index(index);
        for level in 0..guides.levels_of(line.row) {
            let left = (layout.text_left + level_width * level as f32).round();
            let bounds = Bounds::new(point(left, top), size(GUIDE_WIDTH, LINE_HEIGHT));
            lines.push(GuideLine { bounds, active: guides.is_active(line.row, level) });
        }
    }
    lines
}

/// The buffer rows a frame draws, as the first and one past the last, or none when it draws no line.
fn text_rows(layout: &Layout) -> Option<std::ops::Range<usize>> {
    let mut rows = layout.rows.iter().filter_map(|visible| match visible {
        VisibleRow::Text(line) => Some(line.row),
        VisibleRow::Block { .. } => None,
    });
    let first = rows.next()?;
    let last = rows.last().unwrap_or(first);
    Some(first..last + 1)
}

/// Paints the guides behind the text.
pub fn paint_guides(lines: &[GuideLine], theme: &EditorTheme, window: &mut Window) {
    for line in lines {
        let color = if line.active { theme.indent_guide_active } else { theme.indent_guide };
        window.paint_quad(fill(line.bounds, color));
    }
}
