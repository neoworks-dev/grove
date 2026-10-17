//! The popovers of the language features around the cursor, built each frame like the completion
//! panel's: the signature above the cursor, the list of references in the middle of the view with
//! a preview of the code, the menu of code actions at the cursor, and the box a rename is typed in.

use lsp_client::markdown;
use svelte_gpui::gpui::{
    AnyElement, App, AvailableSpace, Bounds, FontWeight, MouseButton, Pixels, Point, StyledText, UnderlineStyle,
    Window, div, point, prelude::*, px, size,
};
use svelte_gpui::gpui::{Entity, HighlightStyle as TextHighlight};

use super::Editor;
use super::element::{FONT_FAMILY, FONT_SIZE, LINE_HEIGHT, Layout, cursor_bounds, measure_text_width};
use super::menu::{MENU_ROWS, Menu, MenuKind, MenuRow, Preview};
use super::popup::{
    GAP, Popover, ROW_HEIGHT, TEXT_SIZE, fit_to_content, markdown_element, place_vertically, popover_background,
    popover_border,
};
use super::rename::RenameBox;
use super::signature::SignatureSession;
use super::theme::{EditorTheme, mix};

const SIGNATURE_MAX_WIDTH: Pixels = px(640.0);
const MENU_WIDTH: Pixels = px(380.0);
const LOCATIONS_WIDTH: Pixels = px(780.0);
const PREVIEW_LINE_HEIGHT: Pixels = px(19.0);

/// Builds the popovers these features ask for, laid out inside `bounds`.
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
    let shown = editor.document;
    let features = &editor.features;
    if let Some(session) = features.signature.as_ref().filter(|s| s.is_visible() && Some(s.document) == shown) {
        popovers.extend(signature_popover(editor, session, layout, theme, bounds, window, cx));
    }
    if let Some(menu) = features.menu.as_ref().filter(|m| m.is_visible() && Some(m.document) == shown) {
        popovers.extend(menu_popovers(entity, editor, menu, layout, theme, bounds, window, cx));
    }
    if let Some(rename) = features.rename.as_ref().filter(|r| r.ready && Some(r.document) == shown) {
        popovers.extend(rename_popover(rename, layout, theme, bounds, window, cx));
    }
    popovers
}

/// The signature above the cursor, with the parameter being typed in bold, and its documentation.
fn signature_popover(
    editor: &Editor,
    session: &SignatureSession,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Popover> {
    let help = session.help.as_ref()?;
    let signature = help.signature(session.choice);
    let head = editor.read(|state| state.selections().newest().head)?;
    let anchor = cursor_bounds(layout, head)?;
    let active = help.parameter_of(signature);
    let mut highlights = Vec::new();
    if let Some(range) = active.and_then(|index| signature.parameters[index].label_range.clone()) {
        let style = TextHighlight {
            color: Some(theme.cursor),
            font_weight: Some(FontWeight::BOLD),
            underline: Some(UnderlineStyle { thickness: px(1.0), color: Some(theme.cursor), wavy: false }),
            ..TextHighlight::default()
        };
        highlights.push((range, style));
    }
    let label = StyledText::new(signature.label.clone()).with_highlights(highlights);
    let mut header = div().flex().items_start().gap(px(12.0)).child(div().flex_1().min_w_0().child(label));
    if help.signatures.len() > 1 {
        let counter = format!("↑↓ {}/{}", session.choice + 1, help.signatures.len());
        header = header.child(div().flex_none().text_size(px(11.0)).text_color(theme.hint).child(counter));
    }
    let documentation = active
        .and_then(|index| signature.parameters[index].documentation.clone())
        .or_else(|| signature.documentation.clone());
    let mut sections: Vec<AnyElement> = vec![header.into_any_element()];
    if let Some(documentation) = documentation {
        let parsed = markdown::parse(&documentation);
        let body =
            div().text_color(mix(theme.background, theme.foreground, 0.75)).child(markdown_element(&parsed, theme));
        sections.push(body.into_any_element());
    }
    let mut element = div()
        .max_w(SIGNATURE_MAX_WIDTH)
        .max_h(px(260.0))
        .overflow_hidden()
        .px(px(10.0))
        .py(px(6.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .bg(popover_background(theme))
        .border_1()
        .border_color(popover_border(theme))
        .rounded(px(6.0))
        .shadow_md()
        .occlude()
        .text_size(TEXT_SIZE)
        .font_family(FONT_FAMILY)
        .text_color(theme.foreground)
        .children(sections)
        .into_any_element();
    let measured = fit_to_content(&mut element, window, cx);
    let above = anchor.top() - GAP - measured.height;
    let top = if above >= bounds.top() { above } else { anchor.top() + LINE_HEIGHT + GAP };
    let left = anchor.left().min(bounds.right() - measured.width).max(bounds.left());
    Some(Popover { element, origin: point(left, top) })
}

/// The list the menu is: references in the middle of the view, actions at the cursor.
fn menu_popovers(
    entity: &Entity<Editor>,
    editor: &Editor,
    menu: &Menu,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Popover> {
    let shown = menu.first_visible..menu.rows.len().min(menu.first_visible + MENU_ROWS);
    let width = match menu.kind {
        MenuKind::Locations => LOCATIONS_WIDTH.min(bounds.size.width - px(40.0)),
        MenuKind::CodeActions => MENU_WIDTH.min(bounds.size.width - px(16.0)),
    };
    let rows: Vec<AnyElement> = shown.clone().map(|position| menu_row(entity, menu, position, theme, window)).collect();
    let mut sections: Vec<AnyElement> = Vec::new();
    if menu.kind == MenuKind::Locations {
        let title = format!("{}  {}/{}", menu.title, menu.selected + 1, menu.rows.len());
        sections.push(
            div().px(px(10.0)).py(px(4.0)).text_color(theme.hint).text_size(px(12.0)).child(title).into_any_element(),
        );
    }
    sections.push(div().flex().flex_col().children(rows).into_any_element());
    if let Some(preview) = menu.selected_row().and_then(|row| row.preview.as_ref()) {
        sections.push(div().h(px(1.0)).bg(popover_border(theme)).into_any_element());
        sections.push(preview_element(preview, theme).into_any_element());
    }
    let mut element = div()
        .w(width)
        .py(px(4.0))
        .flex()
        .flex_col()
        .bg(popover_background(theme))
        .border_1()
        .border_color(popover_border(theme))
        .rounded(px(6.0))
        .shadow_lg()
        .occlude()
        .text_size(TEXT_SIZE)
        .font_family(FONT_FAMILY)
        .text_color(theme.foreground)
        .children(sections)
        .into_any_element();
    let measured =
        element.layout_as_root(size(AvailableSpace::Definite(width), AvailableSpace::MinContent), window, cx);
    let origin = match menu.kind {
        MenuKind::Locations => {
            let left = bounds.left() + (bounds.size.width - width) / 2.0;
            point(left, bounds.top() + px(40.0))
        }
        MenuKind::CodeActions => {
            let head = editor.read(|state| state.selections().newest().head);
            let anchor = head.and_then(|head| cursor_bounds(layout, head));
            let anchor = anchor.map(|anchor| point(anchor.left(), anchor.top())).unwrap_or(bounds.origin);
            let placed = place_vertically(anchor, width, measured.height, bounds);
            point(placed.x.min(bounds.right() - width).max(bounds.left()), placed.y)
        }
    };
    vec![Popover { element, origin }]
}

/// One row of a list: its title, and after it the code of the place or the kind of action.
fn menu_row(
    entity: &Entity<Editor>,
    menu: &Menu,
    position: usize,
    theme: &EditorTheme,
    window: &mut Window,
) -> AnyElement {
    let row: &MenuRow = &menu.rows[position];
    let selected = position == menu.selected;
    let muted = row.disabled.is_some();
    let detail_color = mix(theme.background, theme.foreground, if selected { 0.75 } else { 0.5 });
    let title_color = if muted { theme.hint } else { theme.foreground };
    let click = move |editor: &mut Editor,
                      _: &svelte_gpui::gpui::MouseDownEvent,
                      _: &mut Window,
                      cx: &mut svelte_gpui::gpui::Context<Editor>| {
        editor.choose_menu_row(position, cx);
        cx.stop_propagation();
    };
    let mut line = div()
        .id(("menu-row", position))
        .flex()
        .items_center()
        .h(ROW_HEIGHT)
        .px(px(10.0))
        .gap(px(10.0))
        .when(selected, |line| line.bg(theme.selection))
        .child(div().flex_none().max_w(px(360.0)).truncate().text_color(title_color).child(row.title.clone()));
    if !row.detail.is_empty() {
        line = line.child(
            div().flex_1().min_w_0().truncate().text_size(px(12.0)).text_color(detail_color).child(row.detail.clone()),
        );
    }
    line.on_mouse_down(MouseButton::Left, window.listener_for(entity, click)).into_any_element()
}

/// The code around the selected place, with the place itself marked.
fn preview_element(preview: &Preview, theme: &EditorTheme) -> impl IntoElement {
    let lines: Vec<AnyElement> = preview
        .lines
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let number = format!("{:>4}", preview.first_line + index + 1);
            let is_focus = index == preview.focus;
            let mut code = StyledText::new(if text.is_empty() { " ".to_string() } else { text.clone() });
            if is_focus {
                code = code.with_highlights(focus_highlights(text, preview.columns, theme));
            }
            div()
                .flex()
                .h(PREVIEW_LINE_HEIGHT)
                .items_center()
                .gap(px(10.0))
                .px(px(10.0))
                .when(is_focus, |line| line.bg(mix(theme.background, theme.cursor, 0.12)))
                .child(div().flex_none().text_color(theme.hint).child(number))
                .child(div().flex_1().min_w_0().overflow_hidden().child(code))
                .into_any_element()
        })
        .collect();
    div().py(px(4.0)).flex().flex_col().text_size(px(12.0)).font_family(FONT_FAMILY).children(lines)
}

/// The characters of the focused line that the place covers, in the accent colour and bold.
fn focus_highlights(
    text: &str,
    columns: (usize, usize),
    theme: &EditorTheme,
) -> Vec<(std::ops::Range<usize>, TextHighlight)> {
    let offsets: Vec<usize> = text.char_indices().map(|(offset, _)| offset).collect();
    let Some(&start) = offsets.get(columns.0) else {
        return Vec::new();
    };
    let end = offsets.get(columns.1).copied().unwrap_or(text.len()).max(start);
    if end == start {
        return Vec::new();
    }
    let style =
        TextHighlight { color: Some(theme.cursor), font_weight: Some(FontWeight::BOLD), ..TextHighlight::default() };
    vec![(start..end, style)]
}

/// The box a new name is typed in, drawn over the symbol with its name in it.
fn rename_popover(
    rename: &RenameBox,
    layout: &Layout,
    theme: &EditorTheme,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Popover> {
    let anchor = cursor_bounds(layout, rename.start)?;
    let (before, after) = rename.split_at_caret();
    let text_width = measure_text_width(window, &rename.text) * (FONT_SIZE / px(13.0));
    let caret = div().flex_none().w(px(1.5)).h(px(17.0)).bg(theme.cursor);
    let field = if rename.all_selected {
        div().flex().items_center().child(div().bg(theme.selection).child(rename.text.clone())).child(caret)
    } else {
        div().flex().items_center().child(before).child(caret).child(after)
    };
    let hint = if rename.submitted { "Renaming…" } else { "Enter to rename, Esc to cancel" };
    let mut element = div()
        .min_w((text_width + px(28.0)).max(px(180.0)))
        .px(px(8.0))
        .py(px(4.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .bg(popover_background(theme))
        .border_1()
        .border_color(theme.cursor)
        .rounded(px(5.0))
        .shadow_md()
        .occlude()
        .text_size(FONT_SIZE)
        .font_family(FONT_FAMILY)
        .text_color(theme.foreground)
        .child(field)
        .child(div().text_size(px(10.5)).text_color(theme.hint).child(hint))
        .into_any_element();
    let measured = fit_to_content(&mut element, window, cx);
    let left = (anchor.left() - px(9.0)).min(bounds.right() - measured.width).max(bounds.left());
    let top = (anchor.top() - px(5.0)).min(bounds.bottom() - measured.height).max(bounds.top());
    Some(Popover { element, origin: Point { x: left, y: top } })
}
