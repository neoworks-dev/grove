//! The GPUI element that paints a terminal. Like Zed's terminal element, it is one element for the
//! whole grid: each frame it reads the visible cells into spans (see `grid.rs`), shapes each span
//! once with every character forced onto the cell grid, and paints backgrounds, selection, text
//! and cursor. Only the rows in view are read, so a long scrollback costs nothing to draw.

use alacritty_terminal::vte::ansi::{CursorShape, Rgb};
use svelte_gpui::gpui::{
    App, Bounds, ContentMask, CursorStyle, DispatchPhase, Element, ElementId, ElementInputHandler, Entity, Font,
    GlobalElementId, Hitbox, HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, MouseMoveEvent,
    MouseUpEvent, Pixels, Rgba, ShapedLine, SharedString, StrikethroughStyle, Style, TextRun, UnderlineStyle, Window,
    fill, font, outline, point, px, relative, size,
};

use super::grid::{self, Snapshot, TextSpan, UnderlineKind};
use super::session::{CellPixels, GridSize};
use super::theme::TerminalTheme;
use super::view::{Geometry, TerminalView};

pub const FONT_FAMILY: &str = "DejaVu Sans Mono";

/// Space between the pane's edge and the text, on each side.
const PADDING_X: Pixels = px(8.0);
const PADDING_Y: Pixels = px(4.0);
/// How thick the beam and underline cursors are.
const CURSOR_THICKNESS: Pixels = px(2.0);

pub struct TerminalElement {
    pub view: Entity<TerminalView>,
}

/// What a frame needs to paint, worked out in `prepaint`.
pub struct Frame {
    hitbox: Hitbox,
    background: Hsla,
    painted: Option<Painted>,
    /// What to say instead of a terminal, when the shell could not start.
    message: Option<ShapedLine>,
}

/// The grid of a frame, shaped and ready to paint.
struct Painted {
    backgrounds: Vec<(Bounds<Pixels>, Hsla)>,
    selection: Vec<Bounds<Pixels>>,
    selection_color: Hsla,
    text: Vec<(svelte_gpui::gpui::Point<Pixels>, ShapedLine)>,
    cursor: Option<CursorPaint>,
    composing: Option<(svelte_gpui::gpui::Point<Pixels>, ShapedLine)>,
    link_underline: Option<(Bounds<Pixels>, Hsla)>,
    line_height: Pixels,
    /// The pointer is a hand while Control is held over a link, else a text cursor, or an arrow
    /// for a program that listens to the mouse itself.
    pointer: CursorStyle,
}

/// The cursor and the character it covers.
struct CursorPaint {
    bounds: Bounds<Pixels>,
    shape: CursorShape,
    color: Hsla,
    /// The character drawn over a block cursor in the background's colour.
    covered_text: Option<ShapedLine>,
    visible: bool,
}

/// The size of a cell and the font that sets it.
#[derive(Clone, Copy)]
struct Metrics {
    cell_width: Pixels,
    line_height: Pixels,
    font_size: Pixels,
}

impl IntoElement for TerminalElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Frame;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    /// Fills whatever box the terminal is given.
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

    /// Works out the grid that fits, starts or resizes the shell to it, and shapes what is in view.
    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Frame {
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let theme = self.view.read(cx).theme.clone();
        let background = hsla(theme.background);
        let metrics = measure(self.view.read(cx).font_size, window);
        let (grid_size, origin) = fit_grid(bounds, &metrics);
        let cell_pixels =
            CellPixels { width: f32::from(metrics.cell_width) as u16, height: f32::from(metrics.line_height) as u16 };
        let geometry = Geometry {
            origin,
            cell_width: metrics.cell_width,
            line_height: metrics.line_height,
            columns: grid_size.columns,
            rows: grid_size.rows,
        };
        let session = self.view.update(cx, |view, cx| {
            view.geometry = Some(geometry);
            view.ensure_session(grid_size, cell_pixels, cx)
        });
        let Some(session) = session else {
            let message = self.failure_message(&metrics, &theme, window, cx);
            return Frame { hitbox, background, painted: None, message };
        };
        let snapshot = session.with_term(|term| grid::snapshot(term, &theme));
        let painted = self.build_painted(&snapshot, geometry, &theme, &metrics, window, cx);
        Frame { hitbox, background, painted: Some(painted), message: None }
    }

    /// Paints the background, selection, text, cursor and link underline, and listens to the
    /// pointer for as long as this frame is the one on screen.
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
        let focus = self.view.read(cx).focus.clone();
        let focused = focus.is_focused(window);
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.view.clone()), cx);
        self.listen_to_pointer(bounds, window);
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            window.paint_quad(fill(bounds, frame.background));
            if let Some(message) = &frame.message {
                let _ = message.paint(bounds.origin + point(PADDING_X, PADDING_Y), px(20.0), window, cx);
            }
            let Some(painted) = &frame.painted else {
                return;
            };
            window.set_cursor_style(painted.pointer, &frame.hitbox);
            paint_grid(painted, focused, window, cx);
        });
    }
}

impl TerminalElement {
    /// Shapes the visible spans and works out the boxes of everything else in the frame.
    fn build_painted(
        &self,
        snapshot: &Snapshot,
        geometry: Geometry,
        theme: &TerminalTheme,
        metrics: &Metrics,
        window: &mut Window,
        cx: &mut App,
    ) -> Painted {
        let view = self.view.read(cx);
        let marked_text = view.marked_text.clone();
        let hovered_link = view.hovered_link.clone();
        let cursor_visible = view.cursor_visible;
        let mouse_reported = snapshot.mode.intersects(alacritty_terminal::term::TermMode::MOUSE_MODE);
        let cell_box = |row: usize, column: usize, cell_count: usize| {
            let origin = cell_origin(&geometry, row, column);
            Bounds::new(origin, size(geometry.cell_width * cell_count as f32, geometry.line_height))
        };
        let backgrounds = snapshot
            .backgrounds
            .iter()
            .map(|span| (cell_box(span.row, span.column, span.cell_count), hsla(span.color)))
            .collect();
        let selection =
            snapshot.selection.iter().map(|(row, first, last)| cell_box(*row, *first, last - first + 1)).collect();
        let text = snapshot
            .spans
            .iter()
            .map(|span| (cell_origin(&geometry, span.row, span.column), shape_span(span, metrics, window)))
            .collect();
        let cursor = snapshot.cursor.as_ref().map(|cursor| {
            let cells = if cursor.wide { 2 } else { 1 };
            let covered_text = covered_text(cursor, theme, metrics, window);
            CursorPaint {
                bounds: cell_box(cursor.row, cursor.column, cells),
                shape: cursor.shape,
                color: hsla(theme.cursor),
                covered_text,
                visible: cursor_visible,
            }
        });
        let composing = match (&marked_text, &snapshot.cursor) {
            (Some(marked), Some(cursor)) => Some((
                cell_origin(&geometry, cursor.row, cursor.column),
                shape_composing(marked, theme, metrics, window),
            )),
            _ => None,
        };
        let link_underline = hovered_link.map(|link| {
            let row = (link.line.0 + snapshot.display_offset as i32).max(0) as usize;
            let covered = cell_box(row, link.first_column, link.end_column - link.first_column);
            let thickness = px(1.0);
            let underline = Bounds::new(
                point(covered.origin.x, covered.origin.y + covered.size.height - thickness),
                size(covered.size.width, thickness),
            );
            (underline, hsla(theme.foreground))
        });
        let pointer = pointer_style(link_underline.is_some(), mouse_reported);
        Painted {
            backgrounds,
            selection,
            selection_color: rgba_hsla(theme.selection),
            text,
            cursor,
            composing,
            link_underline,
            line_height: metrics.line_height,
            pointer,
        }
    }

    /// A line saying why there is no terminal.
    fn failure_message(
        &self,
        metrics: &Metrics,
        theme: &TerminalTheme,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<ShapedLine> {
        let failure = self.view.read(cx).failure.clone()?;
        let run = text_run(failure.len(), theme.foreground, false, false, None, false);
        Some(window.text_system().shape_line(SharedString::from(failure), metrics.font_size, &[run], None))
    }

    /// Hands the pointer, wherever it is in the window, to the view: a drag that leaves the
    /// pane keeps selecting, and the button coming up ends it.
    fn listen_to_pointer(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let view = self.view.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let dragging = view.read(cx).is_dragging();
            if !dragging && !bounds.contains(&event.position) {
                return;
            }
            view.update(cx, |view, cx| view.mouse_moved(event.position, event.pressed_button, &event.modifiers, cx));
        });
        let view = self.view.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            view.update(cx, |view, cx| view.mouse_up(event.position, event.button, &event.modifiers, cx));
        });
    }
}

/// Paints a frame's grid: backgrounds, selection, text, the link underline, composed text and the cursor.
fn paint_grid(painted: &Painted, focused: bool, window: &mut Window, cx: &mut App) {
    for (bounds, color) in &painted.backgrounds {
        window.paint_quad(fill(*bounds, *color));
    }
    for bounds in &painted.selection {
        window.paint_quad(fill(*bounds, painted.selection_color));
    }
    for (origin, line) in &painted.text {
        let _ = line.paint(*origin, painted.line_height, window, cx);
    }
    if let Some((bounds, color)) = &painted.link_underline {
        window.paint_quad(fill(*bounds, *color));
    }
    if let Some((origin, line)) = &painted.composing {
        let _ = line.paint(*origin, painted.line_height, window, cx);
    }
    if let Some(cursor) = &painted.cursor {
        paint_cursor(cursor, painted.line_height, focused, window, cx);
    }
}

/// Paints the cursor in its shape: a block that shows the character it covers, a beam, an
/// underline, or an outline when the pane does not have focus.
fn paint_cursor(cursor: &CursorPaint, line_height: Pixels, focused: bool, window: &mut Window, cx: &mut App) {
    if !cursor.visible {
        return;
    }
    let bounds = cursor.bounds;
    if !focused || cursor.shape == CursorShape::HollowBlock {
        window.paint_quad(outline(bounds, cursor.color, svelte_gpui::gpui::BorderStyle::Solid));
        return;
    }
    match cursor.shape {
        CursorShape::Beam => {
            window
                .paint_quad(fill(Bounds::new(bounds.origin, size(CURSOR_THICKNESS, bounds.size.height)), cursor.color));
        }
        CursorShape::Underline => {
            let top = bounds.origin.y + bounds.size.height - CURSOR_THICKNESS;
            let underline = Bounds::new(point(bounds.origin.x, top), size(bounds.size.width, CURSOR_THICKNESS));
            window.paint_quad(fill(underline, cursor.color));
        }
        _ => {
            window.paint_quad(fill(bounds, cursor.color));
            if let Some(text) = &cursor.covered_text {
                let _ = text.paint(bounds.origin, line_height, window, cx);
            }
        }
    }
}

/// The pointer over the terminal.
fn pointer_style(over_link: bool, program_listens: bool) -> CursorStyle {
    if over_link {
        return CursorStyle::PointingHand;
    }
    if program_listens {
        return CursorStyle::Arrow;
    }
    CursorStyle::IBeam
}

/// The top left of a cell.
fn cell_origin(geometry: &Geometry, row: usize, column: usize) -> svelte_gpui::gpui::Point<Pixels> {
    point(
        geometry.origin.x + geometry.cell_width * column as f32,
        geometry.origin.y + geometry.line_height * row as f32,
    )
}

/// The grid that fits in a box, and where its first cell is.
fn fit_grid(bounds: Bounds<Pixels>, metrics: &Metrics) -> (GridSize, svelte_gpui::gpui::Point<Pixels>) {
    let usable_width = (bounds.size.width - PADDING_X * 2.0).max(px(0.0));
    let usable_height = (bounds.size.height - PADDING_Y * 2.0).max(px(0.0));
    let columns = (usable_width / metrics.cell_width).floor() as usize;
    let rows = (usable_height / metrics.line_height).floor() as usize;
    let origin = bounds.origin + point(PADDING_X, PADDING_Y);
    (GridSize::new(columns, rows), origin)
}

/// The font the terminal draws in.
fn terminal_font() -> Font {
    font(FONT_FAMILY)
}

/// The size of a cell for the font at a size: the width of one character, and the height of a line.
fn measure(font_size: f32, window: &mut Window) -> Metrics {
    let font_size = px(font_size);
    let text_system = window.text_system();
    let font_id = text_system.resolve_font(&terminal_font());
    let cell_width = match text_system.advance(font_id, font_size, 'm') {
        Ok(advance) => advance.width,
        Err(_) => font_size * 0.6,
    };
    let ascent = text_system.ascent(font_id, font_size);
    let descent = text_system.descent(font_id, font_size);
    let line_height = (ascent + descent.abs()).ceil();
    Metrics { cell_width, line_height, font_size }
}

/// Shapes a span with each of its characters on the cell grid.
fn shape_span(span: &TextSpan, metrics: &Metrics, window: &mut Window) -> ShapedLine {
    let underline = span.underline.map(|kind| underline_style(kind, span.foreground));
    let run = text_run(span.text.len(), span.foreground, span.bold, span.italic, underline, span.strikethrough);
    let force_width = metrics.cell_width * if span.wide { 2.0 } else { 1.0 };
    window.text_system().shape_line(SharedString::from(span.text.clone()), metrics.font_size, &[run], Some(force_width))
}

/// The character under a block cursor, in the colour of the background so it stays readable.
fn covered_text(
    cursor: &grid::CursorCell,
    theme: &TerminalTheme,
    metrics: &Metrics,
    window: &mut Window,
) -> Option<ShapedLine> {
    if cursor.text.trim().is_empty() {
        return None;
    }
    let run = text_run(cursor.text.len(), theme.background, cursor.bold, cursor.italic, None, false);
    let force_width = metrics.cell_width * if cursor.wide { 2.0 } else { 1.0 };
    Some(window.text_system().shape_line(
        SharedString::from(cursor.text.clone()),
        metrics.font_size,
        &[run],
        Some(force_width),
    ))
}

/// Text an input method is composing, underlined.
fn shape_composing(text: &str, theme: &TerminalTheme, metrics: &Metrics, window: &mut Window) -> ShapedLine {
    let underline = underline_style(UnderlineKind::Single, theme.foreground);
    let run = text_run(text.len(), theme.foreground, false, false, Some(underline), false);
    window.text_system().shape_line(SharedString::from(text.to_string()), metrics.font_size, &[run], None)
}

/// How an underline of a kind is drawn. Double, dotted and dashed fall back to a plain line.
fn underline_style(kind: UnderlineKind, color: Rgb) -> UnderlineStyle {
    UnderlineStyle { thickness: px(1.0), color: Some(hsla(color)), wavy: kind == UnderlineKind::Curly }
}

/// A run of `length` bytes in one style.
fn text_run(
    length: usize,
    color: Rgb,
    bold: bool,
    italic: bool,
    underline: Option<UnderlineStyle>,
    strikethrough: bool,
) -> TextRun {
    let mut run_font = terminal_font();
    if bold {
        run_font = run_font.bold();
    }
    if italic {
        run_font = run_font.italic();
    }
    let strikethrough =
        if strikethrough { Some(StrikethroughStyle { thickness: px(1.0), color: Some(hsla(color)) }) } else { None };
    TextRun { len: length, font: run_font, color: hsla(color), background_color: None, underline, strikethrough }
}

/// A colour of three bytes.
fn hsla(color: Rgb) -> Hsla {
    rgba_hsla([color.r, color.g, color.b, 0xff])
}

/// A colour of four bytes.
fn rgba_hsla(color: [u8; 4]) -> Hsla {
    Rgba {
        r: f32::from(color[0]) / 255.0,
        g: f32::from(color[1]) / 255.0,
        b: f32::from(color[2]) / 255.0,
        a: f32::from(color[3]) / 255.0,
    }
    .into()
}
