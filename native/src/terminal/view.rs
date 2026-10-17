//! The terminal's view, placed in the app as `element("terminal")`.
//!
//! The view shows one session, which the `session` prop names, and turns the keyboard and the
//! pointer into what the shell or the program in it expects: bytes for keys, mouse reports for a
//! program that asked for them, a selection and scrolling for everything else. The painting is
//! `TerminalElement`; the shell and the emulator are in `session.rs`.

use std::ops::Range;
use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use futures::StreamExt;
use futures::channel::mpsc::unbounded;
use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Bounds, ClipboardItem, Context, EntityInputHandler, FocusHandle, IntoElement, KeyDownEvent, Keystroke,
    Modifiers, MouseButton, MouseDownEvent, Pixels, Render, ScrollDelta, ScrollWheelEvent, Subscription, Task,
    UTF16Selection, Window, div, prelude::*, px,
};
use svelte_gpui::{AppElement, CommandError, NativeHost};

use super::element::TerminalElement;
use super::keys::encode_key;
use super::links::{self, Link, LinkTarget};
use super::mouse::{ReportedAction, ReportedButton, ReportedModifiers, encode_mouse, wheel_as_arrows};
use super::session::{CellPixels, GridSize, Session};
use super::theme::TerminalTheme;
use super::{Lookup, Terminals};

/// The text size when the app sets none.
pub const DEFAULT_FONT_SIZE: f32 = 13.0;
/// How long the cursor stays on or off while it blinks.
const BLINK_INTERVAL: Duration = Duration::from_millis(600);
/// How long output is gathered before the view is drawn again, which caps the frame rate of a
/// busy terminal at about 120 frames a second.
const REDRAW_DELAY: Duration = Duration::from_millis(8);
/// Lines a wheel notch scrolls.
const LINES_PER_NOTCH: f32 = 3.0;

/// Which session to show and where to start it.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionSpec {
    pub id: String,
    pub working_directory: String,
}

/// Where the last frame put the grid, which maps the pointer to cells.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    /// The top left of the first cell.
    pub origin: svelte_gpui::gpui::Point<Pixels>,
    pub cell_width: Pixels,
    pub line_height: Pixels,
    pub columns: usize,
    pub rows: usize,
}

/// A cell of the grid under the pointer, and which half of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub row: usize,
    pub column: usize,
    pub side: Side,
}

/// What the left button is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Drag {
    /// Extending the selection.
    Selecting,
    /// Reporting a held button to a program that listens to the mouse.
    Reporting(ReportedButton),
}

pub struct TerminalView {
    terminals: Terminals,
    host: NativeHost,
    pub(super) focus: FocusHandle,
    pub(super) spec: Option<SessionSpec>,
    pub(super) session: Option<Arc<Session>>,
    /// Why the shell could not start, if it could not.
    pub(super) failure: Option<String>,
    pub(super) theme: TerminalTheme,
    pub(super) font_size: f32,
    pub(super) geometry: Option<Geometry>,
    /// Whether the view has the keyboard focus, which only a focused cursor blinks.
    focused: bool,
    /// Whether the pane shows the cursor now; it goes off and on while a blinking cursor blinks.
    pub(super) cursor_visible: bool,
    /// Text an input method is composing, shown at the cursor until it is committed.
    pub(super) marked_text: Option<String>,
    /// The link under the pointer while Control is held, which is underlined.
    pub(super) hovered_link: Option<Link>,
    scroll_remainder: Pixels,
    drag: Option<Drag>,
    /// The last text copied, for where the system clipboard refuses a window without focus.
    last_copied: Option<String>,
    redraw_task: Option<Task<()>>,
    blink_task: Option<Task<()>>,
    focus_subscriptions: Vec<Subscription>,
}

impl TerminalView {
    /// A view that shows nothing until the `session` prop names a session.
    pub fn new(terminals: Terminals, host: NativeHost, cx: &mut Context<Self>) -> Self {
        let mut view = TerminalView {
            terminals,
            host,
            focus: cx.focus_handle(),
            spec: None,
            session: None,
            failure: None,
            theme: TerminalTheme::default(),
            font_size: DEFAULT_FONT_SIZE,
            geometry: None,
            focused: false,
            cursor_visible: true,
            marked_text: None,
            hovered_link: None,
            scroll_remainder: px(0.0),
            drag: None,
            last_copied: None,
            redraw_task: None,
            blink_task: None,
            focus_subscriptions: Vec::new(),
        };
        view.start_blinking(cx);
        view
    }

    /// Shows another session, or none.
    fn show(&mut self, spec: Option<SessionSpec>, cx: &mut Context<Self>) {
        self.spec = spec;
        self.session = None;
        self.failure = None;
        self.geometry = None;
        self.drag = None;
        self.hovered_link = None;
        self.redraw_task = None;
        let Some(spec) = &self.spec else {
            return;
        };
        if let Lookup::Running(session) = self.terminals.lookup(&spec.id) {
            self.attach(session, cx);
        }
    }

    /// Starts drawing the session's output.
    fn attach(&mut self, session: Arc<Session>, cx: &mut Context<Self>) {
        session.set_theme(self.theme.clone());
        let (sender, mut receiver) = unbounded::<()>();
        session.attach(sender);
        let watched = session.clone();
        self.redraw_task = Some(cx.spawn(async move |view, cx| {
            while receiver.next().await.is_some() {
                cx.background_executor().timer(REDRAW_DELAY).await;
                watched.redraw_taken();
                if view.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        }));
        self.session = Some(session);
    }

    /// The session, started now if the view knows its size and the shell has not been started.
    /// Called by the element each frame, because the size of the grid is only known there.
    pub(super) fn ensure_session(
        &mut self,
        grid: GridSize,
        cell: CellPixels,
        cx: &mut Context<Self>,
    ) -> Option<Arc<Session>> {
        if let Some(session) = &self.session {
            session.resize(grid, cell);
            return Some(session.clone());
        }
        let spec = self.spec.clone()?;
        if self.failure.is_some() {
            return None;
        }
        match self.terminals.start(&spec, grid, cell, &self.theme) {
            Ok(Some(session)) => {
                self.attach(session.clone(), cx);
                Some(session)
            }
            Ok(None) => None,
            Err(error) => {
                self.failure = Some(format!("Could not start the shell: {error}"));
                None
            }
        }
    }

    /// Makes the cursor blink while it is a blinking one and the view has focus.
    fn start_blinking(&mut self, cx: &mut Context<Self>) {
        self.blink_task = Some(cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(BLINK_INTERVAL).await;
                let alive = view.update(cx, |view, cx| view.blink(cx));
                if alive.is_err() {
                    return;
                }
            }
        }));
    }

    /// One tick of the blink: toggles the cursor if it should blink, else makes sure it shows.
    fn blink(&mut self, cx: &mut Context<Self>) {
        let blinking = match &self.session {
            Some(session) => session.with_term(|term| term.cursor_style().blinking),
            None => false,
        };
        if blinking && self.focused {
            self.cursor_visible = !self.cursor_visible;
            cx.notify();
            return;
        }
        if !self.cursor_visible {
            self.cursor_visible = true;
            cx.notify();
        }
    }

    /// Redraws when focus moves, since the cursor is hollow without it, and tells programs that
    /// asked to know.
    fn watch_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus_subscriptions.is_empty() {
            return;
        }
        self.focus_subscriptions.push(cx.on_focus_in(&self.focus, window, |view, _, cx| {
            view.focused = true;
            view.report_focus(true);
            cx.notify();
        }));
        self.focus_subscriptions.push(cx.on_focus_out(&self.focus, window, |view, _, _, cx| {
            view.focused = false;
            view.report_focus(false);
            cx.notify();
        }));
    }

    /// Writes the focus-in or focus-out report to a program that turned focus reporting on.
    fn report_focus(&self, focused: bool) {
        let Some(session) = &self.session else {
            return;
        };
        if !self.mode().contains(TermMode::FOCUS_IN_OUT) {
            return;
        }
        let report = if focused { "\x1b[I" } else { "\x1b[O" };
        session.write(report.as_bytes().to_vec());
    }

    /// The terminal's modes, or none set while there is no session.
    pub(super) fn mode(&self) -> TermMode {
        match &self.session {
            Some(session) => session.with_term(|term| *term.mode()),
            None => TermMode::NONE,
        }
    }

    /// Writes bytes to the shell and shows the bottom of the output, as typing does.
    fn send(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        session.with_term(|term| {
            if term.grid().display_offset() > 0 {
                term.scroll_display(Scroll::Bottom);
            }
        });
        session.write(bytes);
        self.cursor_visible = true;
        cx.notify();
    }

    /// Whether a button is held down that the view is following.
    pub(super) fn is_dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// The cell under a point of the window, clamped to the grid, or none before the first frame.
    pub fn hit_at(&self, position: svelte_gpui::gpui::Point<Pixels>) -> Option<Hit> {
        let geometry = self.geometry?;
        Some(hit_in(&geometry, position))
    }
}

/// The cell under a point, clamped to the grid, and which half of it the point is in.
pub fn hit_in(geometry: &Geometry, position: svelte_gpui::gpui::Point<Pixels>) -> Hit {
    let across = ((position.x - geometry.origin.x) / geometry.cell_width).max(0.0);
    let down = ((position.y - geometry.origin.y) / geometry.line_height).max(0.0);
    let column = (across.floor() as usize).min(geometry.columns - 1);
    let row = (down.floor() as usize).min(geometry.rows - 1);
    let side = if across.fract() < 0.5 || across as usize >= geometry.columns { Side::Left } else { Side::Right };
    Hit { row, column, side }
}

/// The grid point of a viewport cell, given how far back the view is scrolled.
fn grid_point(display_offset: usize, hit: Hit) -> Point {
    Point::new(Line(hit.row as i32 - display_offset as i32), Column(hit.column))
}

impl AppElement for TerminalView {
    /// The `session` prop is `{ id, cwd }`, the `theme` prop the colours (see `theme.rs`) and
    /// `fontSize` the size of the text in pixels.
    fn set_prop(&mut self, name: &str, value: Value, cx: &mut Context<Self>) {
        match name {
            "session" => self.set_session_prop(&value, cx),
            "theme" => {
                self.theme = TerminalTheme::from_json(&value);
                if let Some(session) = &self.session {
                    session.set_theme(self.theme.clone());
                }
            }
            "fontSize" => {
                if let Some(size) = value.as_f64() {
                    self.font_size = size.clamp(6.0, 48.0) as f32;
                }
            }
            _ => {}
        }
    }

    fn call(&mut self, method: &str, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        match method {
            "copy" => Ok(json!(self.copy_selection(cx))),
            "paste" => {
                self.paste(cx);
                Ok(Value::Null)
            }
            "selectAll" => {
                self.select_all(cx);
                Ok(Value::Null)
            }
            "clear" => {
                self.send(vec![0x0c], cx);
                Ok(Value::Null)
            }
            "send" => {
                let Some(text) = args.get(0).and_then(Value::as_str) else {
                    return Err(CommandError::with_code("InvalidArguments", "send takes the text to write"));
                };
                self.send(text.as_bytes().to_vec(), cx);
                Ok(Value::Null)
            }
            "selection" => Ok(json!(self.selected_text())),
            _ => Err(CommandError::with_code("UnknownMethod", format!("the terminal has no method {method:?}"))),
        }
    }

    fn focus_handle(&self, _cx: &App) -> Option<FocusHandle> {
        Some(self.focus.clone())
    }
}

impl TerminalView {
    /// Applies a `session` prop: another session to show, or none when it is removed.
    fn set_session_prop(&mut self, value: &Value, cx: &mut Context<Self>) {
        let spec = session_spec(value);
        if spec == self.spec {
            return;
        }
        self.show(spec, cx);
    }

    /// The selected text, if anything is selected.
    fn selected_text(&self) -> Option<String> {
        let session = self.session.as_ref()?;
        session.with_term(|term| term.selection_to_string())
    }

    /// Puts the selection on the clipboard and says whether there was one.
    fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(text) = self.selected_text() else {
            return false;
        };
        if text.is_empty() {
            return false;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        self.last_copied = Some(text);
        true
    }

    /// Types the clipboard's text into the shell, as a paste.
    fn paste(&mut self, cx: &mut Context<Self>) {
        let from_clipboard = cx.read_from_clipboard().and_then(|item| item.text());
        let text = match from_clipboard {
            Some(text) => text,
            None => match &self.last_copied {
                Some(text) => text.clone(),
                None => return,
            },
        };
        self.paste_text(&text, cx);
    }

    /// Types text into the shell the way a paste does: bracketed if the program asked.
    fn paste_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let bytes = paste_bytes(text, self.mode());
        self.send(bytes, cx);
    }

    /// Selects everything the terminal holds, history included.
    fn select_all(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        session.with_term(|term| {
            let top = Point::new(term.topmost_line(), Column(0));
            let bottom = Point::new(term.bottommost_line(), term.last_column());
            let mut selection = Selection::new(SelectionType::Simple, top, Side::Left);
            selection.update(bottom, Side::Right);
            term.selection = Some(selection);
        });
        cx.notify();
    }

    /// Scrolls the history by lines, positive towards older output.
    fn scroll_by(&mut self, lines: i32, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        session.with_term(|term| term.scroll_display(Scroll::Delta(lines)));
        cx.notify();
    }

    /// Scrolls the history by a page, to the top or to the bottom.
    fn scroll_to(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        session.with_term(|term| term.scroll_display(scroll));
        cx.notify();
    }
}

/// The session a `session` prop names: `{ id, cwd }`.
fn session_spec(value: &Value) -> Option<SessionSpec> {
    let id = value.get("id")?.as_str()?;
    let working_directory = value.get("cwd").and_then(Value::as_str).unwrap_or("");
    Some(SessionSpec { id: id.to_string(), working_directory: working_directory.to_string() })
}

/// The bytes that paste `text`: wrapped in the bracketed paste markers, with any escape removed
/// so the text cannot end the paste itself, when the program asked for that; else with line
/// breaks as the carriage returns a keyboard sends.
pub fn paste_bytes(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let safe = text.replace('\x1b', "");
        return format!("\x1b[200~{safe}\x1b[201~").into_bytes();
    }
    text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
}

/// Keys the app keeps for itself, because they open and close the terminal that would otherwise
/// swallow them.
fn belongs_to_the_app(keystroke: &Keystroke) -> bool {
    let modifiers = &keystroke.modifiers;
    keystroke.key == "`" && modifiers.control && !modifiers.alt
}

/// A key's meaning for the terminal view itself rather than for the shell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ViewKey {
    Copy,
    Paste,
    SelectAll,
    PageUp,
    PageDown,
    Top,
    Bottom,
}

/// Which view command, if any, a keystroke is.
fn view_key(keystroke: &Keystroke, mode: TermMode) -> Option<ViewKey> {
    let modifiers = &keystroke.modifiers;
    if modifiers.control && modifiers.shift && !modifiers.alt {
        match keystroke.key.as_str() {
            "c" => return Some(ViewKey::Copy),
            "v" => return Some(ViewKey::Paste),
            "a" => return Some(ViewKey::SelectAll),
            _ => {}
        }
    }
    if modifiers.shift && !modifiers.control && !modifiers.alt && !mode.contains(TermMode::ALT_SCREEN) {
        match keystroke.key.as_str() {
            "pageup" => return Some(ViewKey::PageUp),
            "pagedown" => return Some(ViewKey::PageDown),
            "home" => return Some(ViewKey::Top),
            "end" => return Some(ViewKey::Bottom),
            _ => {}
        }
    }
    None
}

impl TerminalView {
    /// Handles a key, and says whether the terminal used it (else it goes on to the app's keys).
    fn handle_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        if belongs_to_the_app(keystroke) || self.session.is_none() {
            return false;
        }
        self.marked_text = None;
        let mode = self.mode();
        if let Some(command) = view_key(keystroke, mode) {
            self.run_view_key(command, cx);
            return true;
        }
        if let Some(sequence) = encode_key(keystroke, mode) {
            self.send(sequence.into_bytes(), cx);
            return true;
        }
        let Some(text) = typed_text(keystroke) else {
            return false;
        };
        self.send(text.into_bytes(), cx);
        true
    }

    /// Carries out a key that is the terminal's own.
    fn run_view_key(&mut self, command: ViewKey, cx: &mut Context<Self>) {
        match command {
            ViewKey::Copy => {
                self.copy_selection(cx);
            }
            ViewKey::Paste => self.paste(cx),
            ViewKey::SelectAll => self.select_all(cx),
            ViewKey::PageUp => self.scroll_to(Scroll::PageUp, cx),
            ViewKey::PageDown => self.scroll_to(Scroll::PageDown, cx),
            ViewKey::Top => self.scroll_to(Scroll::Top, cx),
            ViewKey::Bottom => self.scroll_to(Scroll::Bottom, cx),
        }
    }
}

/// The text a keystroke types, when it is plain text: no Control, Alt or platform key held.
fn typed_text(keystroke: &Keystroke) -> Option<String> {
    let modifiers = &keystroke.modifiers;
    if modifiers.control || modifiers.alt || modifiers.platform {
        return None;
    }
    let text = keystroke.key_char.as_ref()?;
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    Some(text.clone())
}

/// The mouse buttons the protocol knows.
fn reported_button(button: MouseButton) -> Option<ReportedButton> {
    match button {
        MouseButton::Left => Some(ReportedButton::Left),
        MouseButton::Middle => Some(ReportedButton::Middle),
        MouseButton::Right => Some(ReportedButton::Right),
        _ => None,
    }
}

/// The keys held, as the mouse protocol reports them.
fn reported_modifiers(modifiers: &Modifiers) -> ReportedModifiers {
    ReportedModifiers { shift: modifiers.shift, alt: modifiers.alt, control: modifiers.control }
}

impl TerminalView {
    /// Whether a program asked to hear the mouse and Shift is not held to select regardless.
    fn reports_mouse(&self, modifiers: &Modifiers) -> bool {
        !modifiers.shift && self.mode().intersects(TermMode::MOUSE_MODE)
    }

    /// Writes a mouse report for a cell, if the program asked for this kind of event.
    fn report_mouse(
        &mut self,
        button: ReportedButton,
        action: ReportedAction,
        modifiers: &Modifiers,
        hit: Hit,
        cx: &mut Context<Self>,
    ) {
        let mode = self.mode();
        let sequence = encode_mouse(button, action, reported_modifiers(modifiers), hit.column, hit.row, mode);
        if let Some(sequence) = sequence {
            self.send(sequence.into_bytes(), cx);
        }
    }

    /// A button went down in the view.
    pub(super) fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus);
        self.marked_text = None;
        let Some(hit) = self.hit_at(event.position) else {
            return;
        };
        if self.session.is_none() {
            return;
        }
        if event.button == MouseButton::Left && event.modifiers.control && self.open_link_at(event.position, cx) {
            return;
        }
        if self.reports_mouse(&event.modifiers) {
            let Some(button) = reported_button(event.button) else {
                return;
            };
            self.drag = Some(Drag::Reporting(button));
            self.report_mouse(button, ReportedAction::Press, &event.modifiers, hit, cx);
            return;
        }
        match event.button {
            MouseButton::Left => self.begin_selection(hit, event, cx),
            MouseButton::Middle => self.paste_primary(cx),
            _ => {}
        }
    }

    /// Starts a selection by the number of clicks: cells, words, lines. Shift extends one.
    fn begin_selection(&mut self, hit: Hit, event: &MouseDownEvent, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let kind = match event.click_count {
            1 => SelectionType::Simple,
            2 => SelectionType::Semantic,
            _ => SelectionType::Lines,
        };
        let extend = event.modifiers.shift;
        session.with_term(|term| {
            let point = grid_point(term.grid().display_offset(), hit);
            if extend && let Some(selection) = term.selection.as_mut() {
                selection.update(point, hit.side);
                return;
            }
            term.selection = Some(Selection::new(kind, point, hit.side));
        });
        self.drag = Some(Drag::Selecting);
        cx.notify();
    }

    /// The pointer moved, anywhere in the window. Extends a selection being dragged, reports a
    /// drag or hover to a program that asked, and underlines a link under Control.
    pub(super) fn mouse_moved(
        &mut self,
        position: svelte_gpui::gpui::Point<Pixels>,
        pressed: Option<MouseButton>,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) {
        let Some(hit) = self.hit_at(position) else {
            return;
        };
        match self.drag {
            Some(Drag::Selecting) => self.extend_selection(position, hit, cx),
            Some(Drag::Reporting(button)) => self.report_mouse(button, ReportedAction::Motion, modifiers, hit, cx),
            None => self.hover(position, pressed, modifiers, hit, cx),
        }
    }

    /// The pointer moved with no drag going on.
    fn hover(
        &mut self,
        position: svelte_gpui::gpui::Point<Pixels>,
        pressed: Option<MouseButton>,
        modifiers: &Modifiers,
        hit: Hit,
        cx: &mut Context<Self>,
    ) {
        if pressed.is_none() && self.reports_mouse(modifiers) {
            self.report_mouse(ReportedButton::None, ReportedAction::Motion, modifiers, hit, cx);
        }
        self.update_hovered_link(position, modifiers, cx);
    }

    /// Moves the end of the selection to the pointer, and scrolls while the pointer is above or
    /// below the grid.
    fn extend_selection(&mut self, position: svelte_gpui::gpui::Point<Pixels>, hit: Hit, cx: &mut Context<Self>) {
        let Some(geometry) = self.geometry else {
            return;
        };
        let top = geometry.origin.y;
        let bottom = top + geometry.line_height * geometry.rows as f32;
        if position.y < top {
            self.scroll_by(1, cx);
        } else if position.y > bottom {
            self.scroll_by(-1, cx);
        }
        let Some(session) = &self.session else {
            return;
        };
        session.with_term(|term| {
            let point = grid_point(term.grid().display_offset(), hit);
            if let Some(selection) = term.selection.as_mut() {
                selection.update(point, hit.side);
            }
        });
        cx.notify();
    }

    /// The button came up, anywhere in the window.
    pub(super) fn mouse_up(
        &mut self,
        position: svelte_gpui::gpui::Point<Pixels>,
        button: MouseButton,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) {
        let drag = self.drag.take();
        let Some(hit) = self.hit_at(position) else {
            return;
        };
        match drag {
            Some(Drag::Reporting(reported)) => self.report_mouse(reported, ReportedAction::Release, modifiers, hit, cx),
            Some(Drag::Selecting) if button == MouseButton::Left => self.finish_selection(cx),
            _ => {}
        }
    }

    /// Drops a selection that is only a click, and offers a real one to the primary selection.
    fn finish_selection(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let empty = session.with_term(|term| match &term.selection {
            Some(selection) => selection.is_empty(),
            None => true,
        });
        if empty {
            session.with_term(|term| term.selection = None);
            cx.notify();
            return;
        }
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        if let Some(text) = self.selected_text() {
            cx.write_to_primary(ClipboardItem::new_string(text));
        }
    }

    /// Types the primary selection, which a middle click does.
    fn paste_primary(&mut self, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        if let Some(text) = cx.read_from_primary().and_then(|item| item.text()) {
            self.paste_text(&text, cx);
        }
        #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
        let _ = cx;
    }

    /// The wheel turned: scrolls the history, or tells the program.
    pub(super) fn wheel(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let Some(geometry) = self.geometry else {
            return;
        };
        let Some(hit) = self.hit_at(event.position) else {
            return;
        };
        let lines = self.wheel_lines(event.delta, geometry.line_height);
        if lines == 0 {
            return;
        }
        let mode = self.mode();
        if self.reports_mouse(&event.modifiers) {
            let button = if lines > 0 { ReportedButton::WheelUp } else { ReportedButton::WheelDown };
            for _ in 0..lines.unsigned_abs() {
                self.report_mouse(button, ReportedAction::Press, &event.modifiers, hit, cx);
            }
            return;
        }
        let alternate_scroll = mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL);
        if alternate_scroll && !event.modifiers.shift {
            self.send(wheel_as_arrows(lines, mode).into_bytes(), cx);
            return;
        }
        self.scroll_by(lines, cx);
    }

    /// Whole lines a wheel event amounts to, keeping the pixels of a smooth scroll that do not
    /// make a line yet for the next event. Positive is towards older output.
    fn wheel_lines(&mut self, delta: ScrollDelta, line_height: Pixels) -> i32 {
        match delta {
            ScrollDelta::Lines(lines) => (lines.y * LINES_PER_NOTCH).round() as i32,
            ScrollDelta::Pixels(pixels) => {
                let total = self.scroll_remainder + pixels.y;
                let whole = (total / line_height).trunc();
                self.scroll_remainder = total - line_height * whole;
                whole as i32
            }
        }
    }
}

impl TerminalView {
    /// Where the shell is now, else where it was started.
    fn current_directory(&self, session: &Session) -> Option<String> {
        if let Some(directory) = session.working_directory() {
            return Some(directory.display().to_string());
        }
        self.spec.as_ref().map(|spec| spec.working_directory.clone())
    }

    /// The link at a point of the window, if there is one in the text of its row.
    fn link_at(&self, position: svelte_gpui::gpui::Point<Pixels>) -> Option<Link> {
        let hit = self.hit_at(position)?;
        let session = self.session.as_ref()?;
        let working_directory = self.current_directory(session)?;
        session.with_term(|term| {
            let line = Line(hit.row as i32 - term.grid().display_offset() as i32);
            let row_text = links::row_text(term, line);
            links::find_link(&row_text, hit.column, line, &working_directory)
        })
    }

    /// Opens the link under a Control-click: a URL in the browser, a file in the editor.
    fn open_link_at(&mut self, position: svelte_gpui::gpui::Point<Pixels>, _cx: &mut Context<Self>) -> bool {
        let Some(link) = self.link_at(position) else {
            return false;
        };
        match link.target {
            LinkTarget::Url(url) => open_in_browser(&url),
            LinkTarget::File { path, line, column } => {
                self.host.emit("openpath", json!({ "path": path, "line": line, "column": column }));
            }
        }
        true
    }

    /// Underlines the link under the pointer while Control is held, and stops when it is not.
    fn update_hovered_link(
        &mut self,
        position: svelte_gpui::gpui::Point<Pixels>,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) {
        let link = if modifiers.control { self.link_at(position) } else { None };
        if link == self.hovered_link {
            return;
        }
        self.hovered_link = link;
        cx.notify();
    }
}

/// Opens a URL with the desktop's handler, without waiting for it.
fn open_in_browser(url: &str) {
    let spawned = std::process::Command::new("xdg-open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(error) => eprintln!("could not open {url}: {error}"),
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.watch_focus(window, cx);
        div()
            .id("terminal")
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
                if !view.handle_key(&event.keystroke, cx) {
                    return;
                }
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, event: &MouseDownEvent, window, cx| view.mouse_down(event, window, cx)),
            )
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|view, event: &MouseDownEvent, window, cx| view.mouse_down(event, window, cx)),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|view, event: &MouseDownEvent, window, cx| view.mouse_down(event, window, cx)),
            )
            .on_scroll_wheel(cx.listener(|view, event: &ScrollWheelEvent, _window, cx| view.wheel(event, cx)))
            .child(TerminalElement { view: cx.entity() })
    }
}

/// Typed text and input method composition. Committed text goes to the shell; composed text is
/// only shown at the cursor.
impl EntityInputHandler for TerminalView {
    fn text_for_range(
        &mut self,
        _range: Range<usize>,
        _adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        let marked = self.marked_text.as_ref()?;
        Some(0..marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.marked_text = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked_text = None;
        self.send(text.as_bytes().to_vec(), cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked_text = Some(new_text.to_string()).filter(|text| !text.is_empty());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let geometry = self.geometry?;
        let session = self.session.as_ref()?;
        let (row, column) = session.with_term(|term| {
            let cursor = term.grid().cursor.point;
            (cursor.line.0 + term.grid().display_offset() as i32, cursor.column.0)
        });
        if row < 0 {
            return Some(element_bounds);
        }
        let origin = svelte_gpui::gpui::point(
            geometry.origin.x + geometry.cell_width * column as f32,
            geometry.origin.y + geometry.line_height * row as f32,
        );
        Some(Bounds::new(origin, svelte_gpui::gpui::size(geometry.cell_width, geometry.line_height)))
    }

    fn character_index_for_point(
        &mut self,
        _point: svelte_gpui::gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use svelte_gpui::gpui::{point, px};

    fn keystroke(text: &str) -> Keystroke {
        Keystroke::parse(text).expect("a keystroke")
    }

    fn geometry() -> Geometry {
        Geometry {
            origin: point(px(10.0), px(20.0)),
            cell_width: px(8.0),
            line_height: px(16.0),
            columns: 80,
            rows: 24,
        }
    }

    #[test]
    fn a_point_maps_to_its_cell_and_half() {
        let left = hit_in(&geometry(), point(px(10.0 + 8.0 * 5.0 + 1.0), px(20.0 + 16.0 * 2.0 + 3.0)));
        assert_eq!(left, Hit { row: 2, column: 5, side: Side::Left });
        let right = hit_in(&geometry(), point(px(10.0 + 8.0 * 5.0 + 6.0), px(20.0)));
        assert_eq!(right, Hit { row: 0, column: 5, side: Side::Right });
    }

    #[test]
    fn a_point_outside_the_grid_is_clamped_to_its_edge() {
        let before = hit_in(&geometry(), point(px(0.0), px(0.0)));
        assert_eq!((before.row, before.column), (0, 0));
        let after = hit_in(&geometry(), point(px(5000.0), px(5000.0)));
        assert_eq!((after.row, after.column), (23, 79));
    }

    #[test]
    fn a_hit_in_the_scrollback_is_a_negative_line() {
        let hit = Hit { row: 3, column: 7, side: Side::Left };
        assert_eq!(grid_point(5, hit), Point::new(Line(-2), Column(7)));
        assert_eq!(grid_point(0, hit), Point::new(Line(3), Column(7)));
    }

    #[test]
    fn a_paste_is_bracketed_when_the_program_asked() {
        let bracketed = paste_bytes("a\nb\x1b[201~", TermMode::BRACKETED_PASTE);
        assert_eq!(bracketed, b"\x1b[200~a\nb[201~\x1b[201~".to_vec());
        let plain = paste_bytes("a\r\nb\nc", TermMode::NONE);
        assert_eq!(plain, b"a\rb\rc".to_vec());
    }

    #[test]
    fn terminal_chords_are_the_views_own() {
        assert_eq!(view_key(&keystroke("ctrl-shift-c"), TermMode::NONE), Some(ViewKey::Copy));
        assert_eq!(view_key(&keystroke("ctrl-shift-v"), TermMode::NONE), Some(ViewKey::Paste));
        assert_eq!(view_key(&keystroke("shift-pageup"), TermMode::NONE), Some(ViewKey::PageUp));
        assert_eq!(view_key(&keystroke("ctrl-c"), TermMode::NONE), None);
    }

    #[test]
    fn a_full_screen_program_gets_shift_page_up() {
        assert_eq!(view_key(&keystroke("shift-pageup"), TermMode::ALT_SCREEN), None);
    }

    #[test]
    fn the_toggle_keys_are_left_to_the_app() {
        assert!(belongs_to_the_app(&keystroke("ctrl-`")));
        assert!(belongs_to_the_app(&keystroke("ctrl-shift-`")));
        assert!(!belongs_to_the_app(&keystroke("ctrl-c")));
    }

    #[test]
    fn plain_text_is_typed_and_chords_are_not() {
        let mut typed = keystroke("a");
        typed.key_char = Some("a".to_string());
        assert_eq!(typed_text(&typed).as_deref(), Some("a"));
        let mut chord = keystroke("ctrl-a");
        chord.key_char = Some("a".to_string());
        assert_eq!(typed_text(&chord), None);
        let mut enter = keystroke("enter");
        enter.key_char = Some("\n".to_string());
        assert_eq!(typed_text(&enter), None);
    }

    #[test]
    fn a_session_prop_names_the_id_and_the_directory() {
        let spec = session_spec(&json!({ "id": "t1", "cwd": "/tmp" })).expect("a spec");
        assert_eq!(spec, SessionSpec { id: "t1".to_string(), working_directory: "/tmp".to_string() });
        assert_eq!(session_spec(&json!({ "cwd": "/tmp" })), None);
    }
}
