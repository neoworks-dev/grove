//! The code editor's view, drawn by GPUI and placed in the app as `element("editor")`.
//!
//! What an editor is, and everything that changes it, lives in the `editor_core` crate: an
//! `EditorState` that only `Command`s change, and input layers that turn keys into commands.
//! This view owns one of each and the things only a window has, the scroll offset and the
//! layout of the last frame. It forwards keys and the pointer, applies the commands that come
//! back, scrolls, reports the selections to the app and lets `EditorElement` paint.

mod element;

use std::ops::Range;
use std::path::Path;

use editor_core::{
    Buffer, Command, EditorState, InputContext, InputLayer, KeyInput, Modifiers, Outcome, Position, StandardKeymap,
};
use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Bounds, ClipboardItem, Context, EntityInputHandler, FocusHandle, IntoElement, KeyDownEvent, Keystroke,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, ScrollWheelEvent, Subscription,
    UTF16Selection, Window, div, prelude::*, px,
};
use svelte_gpui::{AppElement, CommandError, NativeHost};

use element::{EditorElement, LINE_HEIGHT, Layout};

pub struct Editor {
    host: NativeHost,
    focus: FocusHandle,
    state: EditorState,
    /// Turns keys into commands: the standard keymap now, a vim layer later.
    input: Box<dyn InputLayer>,
    /// How far the text is scrolled, in pixels from the top of the first line.
    scroll_top: Pixels,
    /// What the last frame drew; none before the first.
    layout: Option<Layout>,
    /// The last text this editor copied. The system clipboard only takes text from a window that
    /// has focus, so where it refuses, a paste still gets this.
    last_copied: Option<String>,
    /// The modified state the app was last told about, so it hears of changes only.
    reported_modified: bool,
    /// Whether the left button went down in the editor and is still held, so moving the
    /// pointer extends the newest selection.
    dragging: bool,
    /// Redraws when focus moves, since the host caches the view and would keep the cursor
    /// as it last drew it.
    focus_subscriptions: Vec<Subscription>,
}

impl Editor {
    /// An empty editor; the `path` prop opens a file in it.
    pub fn new(host: NativeHost, cx: &mut Context<Self>) -> Self {
        Editor {
            host,
            focus: cx.focus_handle(),
            state: EditorState::new(Buffer::empty()),
            input: Box::new(StandardKeymap),
            scroll_top: px(0.0),
            layout: None,
            last_copied: None,
            reported_modified: false,
            dragging: false,
            focus_subscriptions: Vec::new(),
        }
    }

    /// Replaces the buffer with a file, and tells the app whether that worked.
    fn open(&mut self, path: &str) {
        match Buffer::open(Path::new(path)) {
            Ok(buffer) => {
                self.state.replace_buffer(buffer);
                self.scroll_top = px(0.0);
                self.reported_modified = false;
                self.host.emit("opened", json!({ "path": path, "lines": self.state.buffer().line_count() }));
                self.report_selections();
            }
            Err(error) => {
                self.host.emit("error", json!({ "path": path, "message": error.to_string() }));
            }
        }
    }

    /// Applies a command to the state and reacts to what it did: scrolls to follow the newest
    /// cursor, puts copied text on the clipboard, and tells the app about selections, saving and
    /// the modified state. A paste request is filled in from the clipboard first.
    fn apply(&mut self, command: &Command, cx: &mut Context<Self>) -> Outcome {
        let Some(command) = self.resolve_clipboard(command, cx) else {
            return Outcome::default();
        };
        let outcome = self.state.apply(&command);
        if outcome.reveal_newest {
            self.scroll_to_newest();
        }
        if let Some(text) = &outcome.copied {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            self.last_copied = Some(text.clone());
        }
        if outcome.changed {
            self.report_selections();
        }
        self.report_outcome(&outcome);
        outcome
    }

    /// Swaps a request to paste for a paste of the clipboard's text, or of the editor's own last
    /// copy when the clipboard has none, or nothing when there is neither.
    fn resolve_clipboard(&self, command: &Command, cx: &mut Context<Self>) -> Option<Command> {
        if *command != Command::PasteClipboard {
            return Some(command.clone());
        }
        let clipboard_text = cx.read_from_clipboard().and_then(|item| item.text());
        let text = clipboard_text.or_else(|| self.last_copied.clone())?;
        Some(Command::Paste { text })
    }

    /// Tells the app about a save, a failed save, and a change of the modified state.
    fn report_outcome(&mut self, outcome: &Outcome) {
        let path = self.state.buffer().path().map(|path| path.display().to_string());
        if outcome.saved {
            self.host.emit("saved", json!({ "path": path }));
        }
        if let Some(message) = &outcome.error {
            self.host.emit("error", json!({ "path": path, "message": message }));
        }
        let modified = self.state.is_modified();
        if modified != self.reported_modified {
            self.reported_modified = modified;
            self.host.emit("dirty", json!({ "path": path, "modified": modified }));
        }
    }

    /// Handles a key the input layer knows; returns false for the rest, which then bubble to the app.
    fn handle_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let context = InputContext { page_rows: self.rows_in_view() };
        let commands = self.input.translate(&key_input(keystroke), &context);
        if commands.is_empty() {
            return false;
        }
        let mut handled = false;
        for command in &commands {
            let outcome = self.apply(command, cx);
            handled = handled || outcome.changed || !command.passes_on_when_unchanged();
        }
        handled
    }

    /// A press of the left button: a click places one cursor, Alt-click adds or removes one,
    /// Shift-click extends the newest selection, and a double click selects a word.
    fn press(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        let Some(at) = self.position_at(event.position) else {
            return;
        };
        self.dragging = true;
        if event.modifiers.shift {
            self.apply(&Command::ExtendNewestTo { at }, cx);
            return;
        }
        if event.modifiers.alt {
            self.apply(&Command::ToggleCursor { at }, cx);
            return;
        }
        self.apply(&Command::PlaceCursor { at }, cx);
        if event.click_count == 2 {
            self.apply(&Command::SelectWordAt { at }, cx);
        }
    }

    /// The pointer moved with the button held: the newest selection follows it.
    fn drag(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        if !self.dragging || event.pressed_button != Some(MouseButton::Left) {
            return false;
        }
        let Some(at) = self.position_at(event.position) else {
            return false;
        };
        self.apply(&Command::ExtendNewestTo { at }, cx);
        true
    }

    /// The buffer position under a point in the window, or none before the first frame.
    fn position_at(&self, point: svelte_gpui::gpui::Point<Pixels>) -> Option<Position> {
        let layout = self.layout.as_ref()?;
        Some(layout.position_for_point(point))
    }

    /// Scrolls just enough to bring the newest selection's head into view.
    fn scroll_to_newest(&mut self) {
        let Some(layout) = &self.layout else {
            return;
        };
        let head_top = LINE_HEIGHT * self.state.selections().newest().head.row as f32;
        let head_bottom = head_top + LINE_HEIGHT;
        let view_height = layout.bounds.size.height;
        if head_top < self.scroll_top {
            self.scroll_top = head_top;
        } else if head_bottom > self.scroll_top + view_height {
            self.scroll_top = head_bottom - view_height;
        }
    }

    /// Scrolls by the wheel's delta, stopping with the last line at the top.
    fn scroll_by(&mut self, delta: Pixels) {
        let last_line_top = LINE_HEIGHT * self.state.buffer().line_count().saturating_sub(1) as f32;
        self.scroll_top = (self.scroll_top - delta).clamp(px(0.0), last_line_top);
    }

    /// How many rows a page is.
    fn rows_in_view(&self) -> usize {
        match &self.layout {
            Some(layout) => layout.rows_in_view(),
            None => 1,
        }
    }

    /// Tells the app how many cursors there are and where the newest one is.
    fn report_selections(&self) {
        let selections = self.state.selections();
        let newest = selections.newest();
        self.host.emit(
            "selections",
            json!({
                "count": selections.count(),
                "row": newest.head.row,
                "column": newest.head.column,
                "selected": !newest.is_empty(),
            }),
        );
    }

    /// Redraws when the editor gains or loses focus, so the cursor shows it.
    fn watch_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus_subscriptions.is_empty() {
            return;
        }
        let redraw = |_: &mut Editor, _: &mut Window, cx: &mut Context<Editor>| cx.notify();
        self.focus_subscriptions.push(cx.on_focus_in(&self.focus, window, redraw));
        self.focus_subscriptions
            .push(cx.on_focus_out(&self.focus, window, move |editor, _, window, cx| redraw(editor, window, cx)));
    }
}

/// A GPUI keystroke as the input layers see it.
fn key_input(keystroke: &Keystroke) -> KeyInput {
    let modifiers = keystroke.modifiers;
    KeyInput {
        key: keystroke.key.clone(),
        modifiers: Modifiers { control: modifiers.control, alt: modifiers.alt, shift: modifiers.shift },
    }
}

impl AppElement for Editor {
    fn set_prop(&mut self, name: &str, value: Value, _cx: &mut Context<Self>) {
        if name != "path" {
            return;
        }
        let Some(path) = value.as_str() else {
            return;
        };
        if self.state.buffer().path() == Some(Path::new(path)) {
            return;
        }
        self.open(path);
    }

    fn call(&mut self, method: &str, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        match method {
            "selections" => Ok(self.selections_json()),
            "apply" => self.apply_from_app(args, cx),
            _ => Err(CommandError::with_code("UnknownMethod", format!("the editor has no method {method:?}"))),
        }
    }

    fn focus_handle(&self, _cx: &App) -> Option<FocusHandle> {
        Some(self.focus.clone())
    }
}

impl Editor {
    /// The `apply` method: runs the command given as the first argument, as JSON, exactly as a
    /// key would, and answers whether anything changed.
    fn apply_from_app(&mut self, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        let Some(command_json) = args.get(0) else {
            return Err(CommandError::with_code("InvalidCommand", "apply takes a command as its first argument"));
        };
        let command: Command = serde_json::from_value(command_json.clone())
            .map_err(|error| CommandError::with_code("InvalidCommand", error.to_string()))?;
        let outcome = self.apply(&command, cx);
        cx.notify();
        Ok(json!({ "changed": outcome.changed }))
    }

    /// Every selection as the app sees it.
    fn selections_json(&self) -> Value {
        json!(self.state.selections().all().iter().map(selection_json).collect::<Vec<_>>())
    }
}

/// A selection as the app sees it.
fn selection_json(selection: &editor_core::Selection) -> Value {
    json!({
        "anchor": { "row": selection.anchor.row, "column": selection.anchor.column },
        "head": { "row": selection.head.row, "column": selection.head.column },
    })
}

impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.watch_focus(window, cx);
        div()
            .id("editor")
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(|editor, event: &KeyDownEvent, _window, cx| {
                if !editor.handle_key(&event.keystroke, cx) {
                    return;
                }
                cx.notify();
                cx.stop_propagation();
            }))
            .on_scroll_wheel(cx.listener(|editor, event: &ScrollWheelEvent, _window, cx| {
                editor.scroll_by(event.delta.pixel_delta(LINE_HEIGHT).y);
                cx.notify();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|editor, event: &MouseDownEvent, window, cx| {
                    window.focus(&editor.focus);
                    editor.press(event, cx);
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|editor, event: &MouseMoveEvent, _window, cx| {
                if editor.drag(event, cx) {
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|editor, _: &MouseUpEvent, _window, _cx| {
                    editor.dragging = false;
                }),
            )
            .child(EditorElement { editor: cx.entity() })
    }
}

/// Typed text and input method composition. Offsets here are UTF-16 units over the whole text,
/// which is how input methods count; the core's commands use characters, so this converts.
impl EntityInputHandler for Editor {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let buffer = self.state.buffer();
        let (start, end) = (buffer.offset_of_utf16(range.start), buffer.offset_of_utf16(range.end));
        *adjusted = Some(buffer.utf16_of_offset(start)..buffer.utf16_of_offset(end));
        Some(buffer.slice(start..end))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let newest = self.state.selections().newest();
        let buffer = self.state.buffer();
        let anchor = buffer.utf16_of_offset(buffer.offset_of(newest.anchor));
        let head = buffer.utf16_of_offset(buffer.offset_of(newest.head));
        Some(UTF16Selection { range: anchor.min(head)..anchor.max(head), reversed: head < anchor })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        let (start, end) = self.state.marked_range()?;
        Some(self.utf16_range(start, end))
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.apply(&Command::UnmarkText, cx);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let command = self.command_for_replacing(range, text);
        self.apply(&command, cx);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.apply(&Command::SetMarkedText { text: new_text.to_string() }, cx);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let buffer = self.state.buffer();
        let position = buffer.position_of(buffer.offset_of_utf16(range.start));
        let Some(layout) = &self.layout else {
            return Some(element_bounds);
        };
        Some(element::cursor_bounds(layout, position).unwrap_or(element_bounds))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let position = self.position_at(point)?;
        let buffer = self.state.buffer();
        Some(buffer.utf16_of_offset(buffer.offset_of(position)))
    }
}

impl Editor {
    /// The UTF-16 range between two positions.
    fn utf16_range(&self, start: Position, end: Position) -> Range<usize> {
        let buffer = self.state.buffer();
        buffer.utf16_of_offset(buffer.offset_of(start))..buffer.utf16_of_offset(buffer.offset_of(end))
    }

    /// The command for an input method's request to put text over a UTF-16 range. Text that goes
    /// where the cursors are, or over the composed text, is typed at every cursor; a range
    /// elsewhere replaces just that range.
    fn command_for_replacing(&self, range: Option<Range<usize>>, text: &str) -> Command {
        let typing = Command::InsertText { text: text.to_string() };
        let Some(range) = range else {
            return typing;
        };
        let newest = self.state.selections().newest();
        let at_selection = range == self.utf16_range(newest.start(), newest.end());
        let at_composition = match self.state.marked_range() {
            Some((start, end)) => range == self.utf16_range(start, end),
            None => false,
        };
        if at_selection || at_composition {
            return typing;
        }
        let buffer = self.state.buffer();
        Command::ReplaceRange {
            start: buffer.offset_of_utf16(range.start),
            end: buffer.offset_of_utf16(range.end),
            text: text.to_string(),
        }
    }
}
