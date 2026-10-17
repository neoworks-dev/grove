//! The code editor, drawn by GPUI and placed in the app as `element("editor")`.
//!
//! The view owns the buffer, its selections and the scroll offset. `EditorElement` paints it,
//! and this module handles what comes in: props from Svelte, keys, the wheel and the pointer.
//! There can be any number of cursors, as in VS Code: every key acts on all of them.

mod buffer;
mod display;
mod element;
mod movement;
mod selections;

use std::path::Path;

use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Context, FocusHandle, IntoElement, KeyDownEvent, Keystroke, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Render, ScrollWheelEvent, Subscription, Window, div, prelude::*, px,
};
use svelte_gpui::{AppElement, CommandError, NativeHost};

use buffer::{Buffer, Position};
use element::{EditorElement, LINE_HEIGHT, Layout};
use movement::{Motion, find_next, move_selection, vertical, word_at};
use selections::{Selection, Selections};

pub struct Editor {
    host: NativeHost,
    focus: FocusHandle,
    buffer: Buffer,
    selections: Selections,
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
            buffer: Buffer::empty(),
            selections: Selections::single(Position::default()),
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
                self.buffer = buffer;
                self.selections = Selections::single(Position::default());
                self.scroll_top = px(0.0);
                self.host.emit("opened", json!({ "path": path, "lines": self.buffer.line_count() }));
                self.report_selections();
            }
            Err(error) => {
                self.host.emit("error", json!({ "path": path, "message": error.to_string() }));
            }
        }
    }

    /// Handles a key the editor knows; returns false for the rest, which then bubble to the app.
    fn handle_key(&mut self, keystroke: &Keystroke) -> bool {
        let modifiers = keystroke.modifiers;
        let key = keystroke.key.as_str();
        if modifiers.control && modifiers.alt {
            return self.handle_multi_cursor_key(key);
        }
        if modifiers.control {
            return self.handle_control_key(key, modifiers.shift);
        }
        if key == "escape" {
            return self.collapse_selections();
        }
        let Some(motion) = self.motion_for_key(key) else {
            return false;
        };
        self.move_selections(motion, modifiers.shift);
        true
    }

    /// The motion a plain cursor key makes.
    fn motion_for_key(&self, key: &str) -> Option<Motion> {
        let page = self.rows_in_view() as isize;
        let motion = match key {
            "left" => Motion::Left,
            "right" => Motion::Right,
            "up" => Motion::Vertical(-1),
            "down" => Motion::Vertical(1),
            "pageup" => Motion::Vertical(-page),
            "pagedown" => Motion::Vertical(page),
            "home" => Motion::LineStart,
            "end" => Motion::LineEnd,
            _ => return None,
        };
        Some(motion)
    }

    /// Ctrl-Alt-Up and Ctrl-Alt-Down add a cursor on the line above or below.
    fn handle_multi_cursor_key(&mut self, key: &str) -> bool {
        match key {
            "up" => self.add_cursor_vertically(-1),
            "down" => self.add_cursor_vertically(1),
            _ => return false,
        }
        true
    }

    /// Ctrl with another key: the buffer's ends, selecting all, and selecting the next match.
    fn handle_control_key(&mut self, key: &str, shift: bool) -> bool {
        match key {
            "home" => self.move_selections(Motion::BufferStart, shift),
            "end" => self.move_selections(Motion::BufferEnd, shift),
            "a" => self.select_all(),
            "d" => self.select_next_occurrence(),
            _ => return false,
        }
        true
    }

    /// Moves every selection, extending it when Shift is held.
    fn move_selections(&mut self, motion: Motion, extend: bool) {
        let buffer = &self.buffer;
        self.selections.transform(|selection| move_selection(buffer, selection, motion, extend));
        self.scroll_to_newest();
    }

    /// Adds a cursor one line above the topmost selection, or below the bottommost.
    fn add_cursor_vertically(&mut self, direction: isize) {
        let all = self.selections.all();
        let edge = if direction < 0 { all[0] } else { all[all.len() - 1] };
        let (head, goal_column) = vertical(&self.buffer, &edge, direction);
        if head.row == edge.head.row {
            return;
        }
        self.selections.add(Selection { anchor: head, head, goal_column });
        self.scroll_to_newest();
    }

    /// Ctrl-D: selects the word at the newest cursor, or adds a selection at the next place
    /// the newest selection's text occurs.
    fn select_next_occurrence(&mut self) {
        let newest = self.selections.newest();
        if newest.is_empty() {
            if let Some(word) = word_at(&self.buffer, newest.head) {
                self.selections.replace_newest(word);
            }
            return;
        }
        let needle = self.buffer.text_between(newest.start(), newest.end());
        let Some(found) = find_next(&self.buffer, &needle, newest.end()) else {
            return;
        };
        self.selections.add(found);
        self.scroll_to_newest();
    }

    /// Selects the whole buffer.
    fn select_all(&mut self) {
        let end = self.buffer.clamp(Position { row: usize::MAX, column: usize::MAX });
        self.selections = Selections::single(Position::default());
        self.selections.replace_newest(Selection::spanning(Position::default(), end));
    }

    /// Escape: back to one cursor, then to no selection. False when there is nothing to undo,
    /// so the key reaches the app.
    fn collapse_selections(&mut self) -> bool {
        if self.selections.keep_only_newest() {
            return true;
        }
        let newest = self.selections.newest();
        if newest.is_empty() {
            return false;
        }
        self.selections.replace_newest(Selection::cursor(newest.head));
        true
    }

    /// A press of the left button: a click places one cursor, Alt-click adds or removes one,
    /// Shift-click extends the newest selection, and a double click selects a word.
    fn press(&mut self, event: &MouseDownEvent) {
        let Some(layout) = &self.layout else {
            return;
        };
        let at = self.buffer.clamp(layout.position_for_point(event.position));
        self.dragging = true;
        if event.modifiers.shift {
            self.extend_newest_to(at);
            return;
        }
        if event.modifiers.alt {
            if !self.selections.remove_cursor_at(at) {
                self.selections.add(Selection::cursor(at));
            }
            return;
        }
        self.selections = Selections::single(at);
        if event.click_count == 2 {
            self.select_word_at(at);
        }
    }

    /// Moves the newest selection's head while keeping its anchor.
    fn extend_newest_to(&mut self, at: Position) {
        let anchor = self.selections.newest().anchor;
        self.selections.replace_newest(Selection::spanning(anchor, at));
    }

    /// Replaces the newest selection with the word at a position, if there is one.
    fn select_word_at(&mut self, at: Position) {
        if let Some(word) = word_at(&self.buffer, at) {
            self.selections.replace_newest(word);
        }
    }

    /// The pointer moved with the button held: the newest selection follows it.
    fn drag(&mut self, event: &MouseMoveEvent) -> bool {
        if !self.dragging || event.pressed_button != Some(MouseButton::Left) {
            return false;
        }
        let Some(layout) = &self.layout else {
            return false;
        };
        let at = self.buffer.clamp(layout.position_for_point(event.position));
        self.extend_newest_to(at);
        true
    }

    /// Scrolls just enough to bring the newest selection's head into view.
    fn scroll_to_newest(&mut self) {
        let Some(layout) = &self.layout else {
            return;
        };
        let head_top = LINE_HEIGHT * self.selections.newest().head.row as f32;
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
        let last_line_top = LINE_HEIGHT * self.buffer.line_count().saturating_sub(1) as f32;
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
        let newest = self.selections.newest();
        self.host.emit(
            "selections",
            json!({
                "count": self.selections.count(),
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

impl AppElement for Editor {
    fn set_prop(&mut self, name: &str, value: Value, _cx: &mut Context<Self>) {
        if name != "path" {
            return;
        }
        let Some(path) = value.as_str() else {
            return;
        };
        if self.buffer.path() == Some(Path::new(path)) {
            return;
        }
        self.open(path);
    }

    fn call(&mut self, method: &str, _args: Value, _cx: &mut Context<Self>) -> Result<Value, CommandError> {
        match method {
            "selections" => Ok(json!(self.selections.all().iter().map(selection_json).collect::<Vec<_>>())),
            _ => Err(CommandError::with_code("UnknownMethod", format!("the editor has no method {method:?}"))),
        }
    }

    fn focus_handle(&self, _cx: &App) -> Option<FocusHandle> {
        Some(self.focus.clone())
    }
}

/// A selection as the app sees it.
fn selection_json(selection: &Selection) -> Value {
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
