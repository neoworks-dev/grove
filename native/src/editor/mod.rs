//! The code editor's view, drawn by GPUI and placed in the app as `element("editor")`.
//!
//! What an editor is, and everything that changes it, lives in the `editor_core` crate: an
//! `EditorState` that only `Command`s change, and input layers that turn keys into commands.
//! This view owns one of each and the things only a window has, the scroll offset and the
//! layout of the last frame. It forwards keys and the pointer, applies the commands that come
//! back, scrolls, reports the selections to the app and lets `EditorElement` paint.

mod element;

use std::path::Path;

use editor_core::{
    Buffer, Command, EditorState, InputContext, InputLayer, KeyInput, Modifiers, Outcome, Position, StandardKeymap,
};
use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Context, FocusHandle, IntoElement, KeyDownEvent, Keystroke, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Render, ScrollWheelEvent, Subscription, Window, div, prelude::*, px,
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
                self.host.emit("opened", json!({ "path": path, "lines": self.state.buffer().line_count() }));
                self.report_selections();
            }
            Err(error) => {
                self.host.emit("error", json!({ "path": path, "message": error.to_string() }));
            }
        }
    }

    /// Applies a command to the state, then scrolls if the command asks the view to follow.
    fn apply(&mut self, command: &Command) -> Outcome {
        let outcome = self.state.apply(command);
        if outcome.reveal_newest {
            self.scroll_to_newest();
        }
        outcome
    }

    /// Handles a key the input layer knows; returns false for the rest, which then bubble to the app.
    fn handle_key(&mut self, keystroke: &Keystroke) -> bool {
        let context = InputContext { page_rows: self.rows_in_view() };
        let commands = self.input.translate(&key_input(keystroke), &context);
        if commands.is_empty() {
            return false;
        }
        let mut handled = false;
        for command in &commands {
            let outcome = self.apply(command);
            handled = handled || outcome.changed || !command.passes_on_when_unchanged();
        }
        handled
    }

    /// A press of the left button: a click places one cursor, Alt-click adds or removes one,
    /// Shift-click extends the newest selection, and a double click selects a word.
    fn press(&mut self, event: &MouseDownEvent) {
        let Some(at) = self.position_at(event.position) else {
            return;
        };
        self.dragging = true;
        if event.modifiers.shift {
            self.apply(&Command::ExtendNewestTo { at });
            return;
        }
        if event.modifiers.alt {
            self.apply(&Command::ToggleCursor { at });
            return;
        }
        self.apply(&Command::PlaceCursor { at });
        if event.click_count == 2 {
            self.apply(&Command::SelectWordAt { at });
        }
    }

    /// The pointer moved with the button held: the newest selection follows it.
    fn drag(&mut self, event: &MouseMoveEvent) -> bool {
        if !self.dragging || event.pressed_button != Some(MouseButton::Left) {
            return false;
        }
        let Some(at) = self.position_at(event.position) else {
            return false;
        };
        self.apply(&Command::ExtendNewestTo { at });
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

    fn call(&mut self, method: &str, args: Value, _cx: &mut Context<Self>) -> Result<Value, CommandError> {
        match method {
            "selections" => Ok(self.selections_json()),
            "apply" => self.apply_from_app(args),
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
    fn apply_from_app(&mut self, args: Value) -> Result<Value, CommandError> {
        let Some(command_json) = args.get(0) else {
            return Err(CommandError::with_code("InvalidCommand", "apply takes a command as its first argument"));
        };
        let command: Command = serde_json::from_value(command_json.clone())
            .map_err(|error| CommandError::with_code("InvalidCommand", error.to_string()))?;
        let outcome = self.apply(&command);
        self.report_selections();
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
                if !editor.handle_key(&event.keystroke) {
                    return;
                }
                editor.report_selections();
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
                    editor.press(event);
                    editor.report_selections();
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|editor, event: &MouseMoveEvent, _window, cx| {
                if editor.drag(event) {
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|editor, _: &MouseUpEvent, _window, _cx| {
                    editor.dragging = false;
                    editor.report_selections();
                }),
            )
            .child(EditorElement { editor: cx.entity() })
    }
}
