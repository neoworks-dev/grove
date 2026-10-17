//! Jump labels as the view paints them: a background behind each match of what was typed, a small
//! label over the text that follows it (so the match itself stays readable), and a note of what has
//! been typed so far in the corner. What the labels are comes from `editor_core::jump`.

use svelte_gpui::gpui::{Bounds, Pixels, ShapedLine, Window, fill, point, px, size};

use super::element::{LINE_HEIGHT, Layout, shape_plain, span_bounds};
use super::theme::EditorTheme;
use editor_core::Position;
use editor_core::jump::JumpSession;

/// Space on each side of a label's letters.
const LABEL_PADDING: Pixels = px(2.0);
/// How round a label's corners are.
const LABEL_RADIUS: Pixels = px(3.0);
/// The note of what has been typed sits this far from the top and right of the view.
const NOTE_MARGIN: Pixels = px(10.0);
const NOTE_PADDING: Pixels = px(8.0);

/// One label, placed.
struct LabelPaint {
    bounds: Bounds<Pixels>,
    text: ShapedLine,
}

/// The note of what has been typed, placed.
struct NotePaint {
    bounds: Bounds<Pixels>,
    text: ShapedLine,
}

/// Everything the jump adds to a frame.
#[derive(Default)]
pub struct JumpPaint {
    /// Behind the text: what the typed characters matched.
    matches: Vec<Bounds<Pixels>>,
    labels: Vec<LabelPaint>,
    note: Option<NotePaint>,
}

/// Places the matches, labels and note of a jump session over the rows that were drawn. When half
/// of a two letter label has been typed, only the labels that start with it stay, showing the rest.
pub fn build(
    session: &JumpSession,
    layout: &Layout,
    theme: &EditorTheme,
    character_width: Pixels,
    window: &mut Window,
) -> JumpPaint {
    let typed = session.typed_label();
    let mut paint = JumpPaint::default();
    for found in session.matches() {
        let end = Position { row: found.start.row, column: found.start.column + found.length };
        paint.matches.extend(span_bounds(layout, found.start, end, px(0.0)));
        let Some(label) = found.label.as_deref().and_then(|label| label.strip_prefix(typed)) else {
            continue;
        };
        let Some((line, top)) = layout.line_of(found.start.row) else {
            continue;
        };
        let left = layout.text_left + line.shaped.x_for_index(line.display.range_end_offset(end.column));
        let width = character_width * label.chars().count() as f32 + LABEL_PADDING * 2.0;
        let bounds = Bounds::new(point(left - LABEL_PADDING, top), size(width, LINE_HEIGHT));
        paint.labels.push(LabelPaint { bounds, text: shape_plain(window, label, theme.jump_label_text) });
    }
    paint.note = note(session, layout, theme, window);
    paint
}

/// The note in the corner of the view: what has been typed to search for.
fn note(session: &JumpSession, layout: &Layout, theme: &EditorTheme, window: &mut Window) -> Option<NotePaint> {
    let text = shape_plain(window, &format!("jump {}", session.pattern()), theme.foreground);
    let width = text.width + NOTE_PADDING * 2.0;
    let left = layout.bounds.right() - NOTE_MARGIN - width;
    let bounds = Bounds::new(point(left, layout.bounds.top() + NOTE_MARGIN), size(width, LINE_HEIGHT));
    Some(NotePaint { bounds, text })
}

/// Paints the background of what the typed characters matched.
pub fn paint_behind_text(paint: &JumpPaint, theme: &EditorTheme, window: &mut Window) {
    for found in &paint.matches {
        window.paint_quad(fill(*found, theme.jump_match));
    }
}

/// Paints the labels and the note over the text.
pub fn paint_over_text(paint: &JumpPaint, theme: &EditorTheme, window: &mut Window, cx: &mut svelte_gpui::gpui::App) {
    for label in &paint.labels {
        window.paint_quad(fill(label.bounds, theme.jump_label).corner_radii(LABEL_RADIUS));
        let origin = point(label.bounds.left() + LABEL_PADDING, label.bounds.top());
        let _ = label.text.paint(origin, LINE_HEIGHT, window, cx);
    }
    let Some(note) = &paint.note else {
        return;
    };
    window.paint_quad(fill(note.bounds, theme.current_line).corner_radii(LABEL_RADIUS));
    let origin = point(note.bounds.left() + NOTE_PADDING, note.bounds.top());
    let _ = note.text.paint(origin, LINE_HEIGHT, window, cx);
}
