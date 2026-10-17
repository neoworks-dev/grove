//! The popovers drawn over the text: the completion panel with the documentation of its selected
//! item beside it, and the hover. They are built each frame from the editor's state while it is
//! being laid out, so they follow the cursor in the very frame it moves, and drawn after
//! everything else so they sit on top.

use lsp_client::completion::{Item, KindFamily};
use lsp_client::markdown::{self, Block, Span};
use svelte_gpui::gpui::{
    AnyElement, App, AvailableSpace, Bounds, Entity, FontStyle, FontWeight, Hsla, MouseButton, Pixels, Point, Size,
    StrikethroughStyle, StyledText, UnderlineStyle, Window, div, point, prelude::*, px, size,
};

use super::Editor;
use super::completion::{Session, VISIBLE_ROWS};
use super::element::{FONT_FAMILY, LINE_HEIGHT, Layout, cursor_bounds, measure_text_width};
use super::hover::Hover;
use super::language::severity_of;
use super::theme::{EditorTheme, mix};
use lsp_client::protocol::Severity;
use svelte_gpui::gpui::HighlightStyle as TextHighlight;

pub(super) const ROW_HEIGHT: Pixels = px(24.0);
const BADGE_SIZE: Pixels = px(18.0);
const PANEL_MIN_WIDTH: f32 = 300.0;
const PANEL_MAX_WIDTH: f32 = 620.0;
const DETAIL_MAX_WIDTH: f32 = 240.0;
const DOCUMENTATION_WIDTH: Pixels = px(380.0);
const DOCUMENTATION_MAX_HEIGHT: Pixels = px(320.0);
const HOVER_WIDTH: Pixels = px(560.0);
const HOVER_MAX_HEIGHT: Pixels = px(360.0);
pub(super) const TEXT_SIZE: Pixels = px(13.0);
/// Space between a popover and the line it belongs to.
pub(super) const GAP: Pixels = px(3.0);

/// A popover ready to be drawn, and where its top left corner goes.
pub struct Popover {
    pub element: AnyElement,
    pub origin: Point<Pixels>,
}

/// Builds the popovers the editor's state asks for, laid out inside `bounds`.
pub fn build(
    entity: &Entity<Editor>,
    editor: &Editor,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Popover> {
    let mut popovers = Vec::new();
    let shown_document = editor.document;
    let session =
        editor.completion.as_ref().filter(|session| session.is_visible() && Some(session.document) == shown_document);
    if let Some(session) = session {
        popovers.extend(completion_popovers(entity, editor, session, layout, theme, bounds, window, cx));
    }
    if let (Some(hover), true) = (&editor.hover, editor.completion.is_none()) {
        popovers.extend(hover_popover(hover, layout, theme, bounds, window, cx));
    }
    popovers.extend(super::feature_popups::build(entity, editor, layout, theme, bounds, window, cx));
    popovers
}

/// The panel of items, and the documentation of the selected one beside it.
fn completion_popovers(
    entity: &Entity<Editor>,
    editor: &Editor,
    session: &Session,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Popover> {
    let Some(start) = editor.read(|state| state.anchor_position(session.start)).flatten() else {
        return Vec::new();
    };
    let Some(anchor) = cursor_bounds(layout, start) else {
        return Vec::new();
    };
    let shown: Vec<usize> =
        (session.first_visible..session.matches.len().min(session.first_visible + VISIBLE_ROWS)).collect();
    let width = panel_width(session, &shown, window);
    let height = ROW_HEIGHT * shown.len() as f32 + px(8.0);
    let left = (anchor.left() - px(8.0) - BADGE_SIZE - px(8.0)).max(layout.bounds.left() + px(4.0));
    let origin = place_vertically(point(left, anchor.top()), width, height, bounds);
    let rows = shown.iter().map(|position| panel_row(entity, session, *position, theme, window));
    let panel = div()
        .w(width)
        .py(px(4.0))
        .flex()
        .flex_col()
        .bg(popover_background(theme))
        .border_1()
        .border_color(popover_border(theme))
        .rounded(px(6.0))
        .shadow_md()
        .occlude()
        .text_size(TEXT_SIZE)
        .font_family(FONT_FAMILY)
        .text_color(theme.foreground)
        .children(rows)
        .into_any_element();
    let mut panel = panel;
    panel.layout_as_root(size(AvailableSpace::Definite(width), AvailableSpace::MinContent), window, cx);
    let mut popovers = vec![Popover { element: panel, origin }];
    if let Some(documentation) = documentation_popover(session, theme, origin, width, bounds, window, cx) {
        popovers.push(documentation);
    }
    popovers
}

/// How wide the panel is: as wide as its widest label and detail, within limits.
fn panel_width(session: &Session, shown: &[usize], window: &mut Window) -> Pixels {
    let mut label_width = 0.0f32;
    let mut detail_width = 0.0f32;
    for position in shown {
        let item = &session.items[session.matches[*position].index];
        label_width = label_width.max(f32::from(measure_text_width(window, &item.label)));
        if let Some(detail) = &item.detail {
            detail_width = detail_width.max(f32::from(measure_text_width(window, detail)));
        }
    }
    let detail_width = detail_width.min(DETAIL_MAX_WIDTH);
    let content = f32::from(BADGE_SIZE) + 8.0 + label_width + 12.0 + detail_width + 16.0;
    px(content.clamp(PANEL_MIN_WIDTH, PANEL_MAX_WIDTH))
}

/// One row of the panel: the kind's badge, the label with what matched what was typed
/// emphasised, and the detail after it.
fn panel_row(
    entity: &Entity<Editor>,
    session: &Session,
    position: usize,
    theme: &EditorTheme,
    window: &mut Window,
) -> AnyElement {
    let found = &session.matches[position];
    let item = &session.items[found.index];
    let selected = position == session.selected;
    let label =
        StyledText::new(item.label.clone()).with_highlights(label_highlights(item, &found.label_positions, theme));
    let click = move |editor: &mut Editor,
                      _: &svelte_gpui::gpui::MouseDownEvent,
                      _: &mut Window,
                      cx: &mut svelte_gpui::gpui::Context<Editor>| {
        editor.accept_completion_row(position, cx);
        cx.stop_propagation();
    };
    let mut row = div()
        .id(("completion-row", position))
        .flex()
        .items_center()
        .h(ROW_HEIGHT)
        .px(px(8.0))
        .gap(px(8.0))
        .when(selected, |row| row.bg(theme.selection))
        .child(kind_badge(item, theme))
        .child(div().flex_none().child(label));
    if let Some(detail) = &item.detail {
        row = row.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .text_color(detail_color(theme, selected))
                .child(detail.clone()),
        );
    }
    row = row.on_mouse_down(MouseButton::Left, window.listener_for(entity, click));
    row.into_any_element()
}

/// The colour of a row's detail: dim, but readable on the selected row's background too.
fn detail_color(theme: &EditorTheme, selected: bool) -> Hsla {
    let amount = if selected { 0.75 } else { 0.5 };
    mix(theme.background, theme.foreground, amount)
}

/// The coloured square with a letter that says what kind of item a row is.
fn kind_badge(item: &Item, theme: &EditorTheme) -> impl IntoElement {
    let color = family_color(item.kind.family(), theme);
    div()
        .flex_none()
        .w(BADGE_SIZE)
        .h(BADGE_SIZE)
        .rounded(px(4.0))
        .bg(color.opacity(0.2))
        .text_color(color)
        .text_size(px(11.0))
        .font_weight(FontWeight::BOLD)
        .flex()
        .items_center()
        .justify_center()
        .child(item.kind.glyph())
}

/// The colour a family of kinds is drawn in: the theme's own syntax colours where it has them.
fn family_color(family: KindFamily, theme: &EditorTheme) -> Hsla {
    let named = |name: &str, fallback: Hsla| theme.syntax_color(name).unwrap_or(fallback);
    match family {
        KindFamily::Callable => named("function", theme.info),
        KindFamily::Value => named("variable", theme.added),
        KindFamily::Type => named("type", theme.warning),
        KindFamily::Keyword => named("keyword", theme.modified),
        KindFamily::Plain => theme.hint,
    }
}

/// How the label's text is emphasised: the matched characters in the accent colour and bold, and
/// a deprecated item struck through.
fn label_highlights(
    item: &Item,
    positions: &[usize],
    theme: &EditorTheme,
) -> Vec<(std::ops::Range<usize>, TextHighlight)> {
    let mut highlights = Vec::new();
    let offsets: Vec<usize> = item.label.char_indices().map(|(offset, _)| offset).collect();
    for position in positions {
        let Some(start) = offsets.get(*position).copied() else {
            continue;
        };
        let end = offsets.get(position + 1).copied().unwrap_or(item.label.len());
        let mut style = TextHighlight {
            color: Some(theme.cursor),
            font_weight: Some(FontWeight::BOLD),
            ..TextHighlight::default()
        };
        if item.deprecated {
            style.strikethrough = Some(StrikethroughStyle { thickness: px(1.0), color: Some(theme.hint) });
        }
        highlights.push((start..end, style));
    }
    if item.deprecated && highlights.is_empty() {
        let style = TextHighlight {
            strikethrough: Some(StrikethroughStyle { thickness: px(1.0), color: Some(theme.hint) }),
            ..TextHighlight::default()
        };
        highlights.push((0..item.label.len(), style));
    }
    highlights
}

/// The documentation of the selected item, beside the panel on the side with room.
fn documentation_popover(
    session: &Session,
    theme: &EditorTheme,
    panel_origin: Point<Pixels>,
    panel_width: Pixels,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Popover> {
    let item = session.selected_item()?;
    let documentation = item.documentation.as_deref();
    let mut sections: Vec<AnyElement> = Vec::new();
    if let Some(detail) = item.detail.as_deref().filter(|_| documentation.is_some()) {
        sections.push(code_block(detail, theme).into_any_element());
    }
    if let Some(documentation) = documentation {
        sections.push(markdown_element(&markdown::parse(documentation), theme).into_any_element());
    }
    if sections.is_empty() {
        return None;
    }
    let mut element = div()
        .max_w(DOCUMENTATION_WIDTH)
        .max_h(DOCUMENTATION_MAX_HEIGHT)
        .overflow_hidden()
        .p(px(10.0))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .bg(popover_background(theme))
        .border_1()
        .border_color(popover_border(theme))
        .rounded(px(6.0))
        .shadow_md()
        .occlude()
        .text_size(TEXT_SIZE)
        .text_color(theme.foreground)
        .children(sections)
        .into_any_element();
    let measured = fit_to_content(&mut element, window, cx);
    let fits_right = panel_origin.x + panel_width + px(4.0) + measured.width <= bounds.right();
    let left =
        if fits_right { panel_origin.x + panel_width + px(4.0) } else { panel_origin.x - measured.width - px(4.0) };
    let top = panel_origin.y.min(bounds.bottom() - measured.height).max(bounds.top());
    Some(Popover { element, origin: point(left.max(bounds.left()), top) })
}

/// Lays a popover out as wide as its content, up to its own maximum width, and as tall as the
/// text then needs. Measuring the width first and then laying out at that width is what makes
/// the text wrap where the box ends, so the height is not that of unwrapped lines.
pub(super) fn fit_to_content(element: &mut AnyElement, window: &mut Window, cx: &mut App) -> Size<Pixels> {
    let natural = element.layout_as_root(size(AvailableSpace::MaxContent, AvailableSpace::MaxContent), window, cx);
    element.layout_as_root(size(AvailableSpace::Definite(natural.width), AvailableSpace::MaxContent), window, cx)
}

/// The hover: diagnostics first, then what the server says.
fn hover_popover(
    hover: &Hover,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Popover> {
    if !hover.has_content() {
        return None;
    }
    let anchor = cursor_bounds(layout, hover.range.0)?;
    let mut sections: Vec<AnyElement> = Vec::new();
    let mut diagnostics: Vec<_> = hover.diagnostics.iter().collect();
    diagnostics.sort_by_key(|diagnostic| severity_rank(severity_of(diagnostic.tone)));
    for diagnostic in diagnostics {
        sections.push(diagnostic_section(&diagnostic.message, theme.tone(diagnostic.tone), theme).into_any_element());
    }
    if let (Some(markdown), false) = (&hover.markdown, hover.diagnostics.is_empty()) {
        sections.push(div().h(px(1.0)).bg(popover_border(theme)).into_any_element());
        sections.push(markdown_element(&markdown::parse(markdown), theme).into_any_element());
    } else if let Some(markdown) = &hover.markdown {
        sections.push(markdown_element(&markdown::parse(markdown), theme).into_any_element());
    }
    let mut element = div()
        .max_w(HOVER_WIDTH)
        .max_h(HOVER_MAX_HEIGHT)
        .overflow_hidden()
        .p(px(10.0))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .bg(popover_background(theme))
        .border_1()
        .border_color(popover_border(theme))
        .rounded(px(6.0))
        .shadow_md()
        .occlude()
        .text_size(TEXT_SIZE)
        .text_color(theme.foreground)
        .children(sections)
        .into_any_element();
    let measured = fit_to_content(&mut element, window, cx);
    let origin = place_vertically(point(anchor.left(), anchor.top()), measured.width, measured.height, bounds);
    let left = origin.x.min(bounds.right() - measured.width).max(bounds.left());
    Some(Popover { element, origin: point(left, origin.y) })
}

/// A diagnostic in a hover: a bar in its colour, and the message.
fn diagnostic_section(message: &str, color: Hsla, theme: &EditorTheme) -> impl IntoElement {
    div()
        .flex()
        .gap(px(8.0))
        .child(div().flex_none().w(px(3.0)).rounded(px(2.0)).bg(color))
        .child(div().flex_1().min_w_0().child(markdown_element(&markdown::parse(message), theme)))
}

/// How bad a severity is, for ordering; lower is worse.
fn severity_rank(severity: Severity) -> u8 {
    match severity {
        Severity::Error => 0,
        Severity::Warning => 1,
        Severity::Information => 2,
        Severity::Hint => 3,
    }
}

/// Places a popover below the line it belongs to, or above it when there is not room below and
/// there is above.
pub(super) fn place_vertically(
    line: Point<Pixels>,
    _width: Pixels,
    height: Pixels,
    bounds: Bounds<Pixels>,
) -> Point<Pixels> {
    let below = line.y + LINE_HEIGHT + GAP;
    let fits_below = below + height <= bounds.bottom();
    let above = line.y - GAP - height;
    if fits_below || above < bounds.top() {
        return point(line.x, below.min((bounds.bottom() - height).max(bounds.top())));
    }
    point(line.x, above)
}

/// The colour popovers are filled with: a little lighter than the editor's.
pub(super) fn popover_background(theme: &EditorTheme) -> Hsla {
    mix(theme.background, theme.foreground, 0.07)
}

/// The colour of a popover's border.
pub(super) fn popover_border(theme: &EditorTheme) -> Hsla {
    mix(theme.background, theme.foreground, 0.2)
}

/// Markdown as elements: paragraphs and headings wrap, code sits in blocks, lists are indented.
pub(super) fn markdown_element(blocks: &[Block], theme: &EditorTheme) -> impl IntoElement {
    let children: Vec<AnyElement> = blocks.iter().map(|block| block_element(block, theme)).collect();
    div().flex().flex_col().gap(px(6.0)).children(children)
}

/// One block of markdown.
fn block_element(block: &Block, theme: &EditorTheme) -> AnyElement {
    match block {
        Block::Paragraph(spans) => spans_text(spans, theme).into_any_element(),
        Block::Heading { level, spans } => {
            let size = if *level <= 2 { px(15.0) } else { TEXT_SIZE };
            div().text_size(size).font_weight(FontWeight::BOLD).child(spans_text(spans, theme)).into_any_element()
        }
        Block::ListItem { depth, marker, spans } => div()
            .flex()
            .gap(px(6.0))
            .pl(px(12.0 * *depth as f32))
            .child(div().flex_none().text_color(theme.hint).child(marker.clone()))
            .child(div().flex_1().min_w_0().child(spans_text(spans, theme)))
            .into_any_element(),
        Block::Quote(spans) => div()
            .pl(px(8.0))
            .border_l_2()
            .border_color(popover_border(theme))
            .text_color(theme.hint)
            .child(spans_text(spans, theme))
            .into_any_element(),
        Block::Code { text, .. } => code_block(text, theme).into_any_element(),
        Block::Rule => div().h(px(1.0)).bg(popover_border(theme)).into_any_element(),
    }
}

/// Code in a block of its own, in the editor's font.
pub(super) fn code_block(text: &str, theme: &EditorTheme) -> impl IntoElement {
    div()
        .w_full()
        .px(px(8.0))
        .py(px(6.0))
        .rounded(px(4.0))
        .bg(mix(theme.background, theme.foreground, 0.03))
        .font_family(FONT_FAMILY)
        .text_size(px(12.5))
        .child(text.to_string())
}

/// The text of some spans, with bold, italic, code and links styled.
fn spans_text(spans: &[Span], theme: &EditorTheme) -> StyledText {
    let mut text = String::new();
    let mut highlights = Vec::new();
    for span in spans {
        let start = text.len();
        text.push_str(&span.text);
        let end = text.len();
        if end == start {
            continue;
        }
        let mut style = TextHighlight::default();
        if span.style.bold {
            style.font_weight = Some(FontWeight::BOLD);
        }
        if span.style.italic {
            style.font_style = Some(FontStyle::Italic);
        }
        if span.style.code {
            style.background_color = Some(mix(theme.background, theme.foreground, 0.1));
            style.color = Some(theme.foreground);
        }
        if span.style.link {
            style.color = Some(theme.info);
            style.underline = Some(UnderlineStyle { thickness: px(1.0), color: Some(theme.info), wavy: false });
        }
        if span.style.strikethrough {
            style.strikethrough = Some(StrikethroughStyle { thickness: px(1.0), color: None });
        }
        if style != TextHighlight::default() {
            highlights.push((start..end, style));
        }
    }
    StyledText::new(text).with_highlights(highlights)
}
