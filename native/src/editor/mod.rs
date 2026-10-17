//! The code editor, drawn by GPUI and placed in the app as `element("editor")`.
//!
//! The view owns the buffer, the cursor and the scroll offset. `EditorElement` paints it,
//! and this module handles what comes in: props from Svelte, keys, the wheel and the pointer.

mod buffer;
mod display;
mod element;

use std::path::Path;

use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Context, FocusHandle, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, Pixels, Render,
    ScrollWheelEvent, Subscription, Window, div, prelude::*, px,
};
use svelte_gpui::{AppElement, CommandError, NativeHost};

use buffer::{Buffer, Position};
use element::{EditorElement, LINE_HEIGHT, Layout};

pub struct Editor {
    host: NativeHost,
    focus: FocusHandle,
    buffer: Buffer,
    cursor: Position,
    /// The column up and down aim for, so moving through a short line and back keeps it.
    goal_column: Option<usize>,
    /// How far the text is scrolled, in pixels from the top of the first line.
    scroll_top: Pixels,
    /// What the last frame drew; none before the first.
    layout: Option<Layout>,
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
            cursor: Position::default(),
            goal_column: None,
            scroll_top: px(0.0),
            layout: None,
            focus_subscriptions: Vec::new(),
        }
    }

    /// Replaces the buffer with a file, and tells the app whether that worked.
    fn open(&mut self, path: &str) {
        match Buffer::open(Path::new(path)) {
            Ok(buffer) => {
                self.buffer = buffer;
                self.cursor = Position::default();
                self.goal_column = None;
                self.scroll_top = px(0.0);
                self.host.emit("opened", json!({ "path": path, "lines": self.buffer.line_count() }));
            }
            Err(error) => {
                self.host.emit("error", json!({ "path": path, "message": error.to_string() }));
            }
        }
    }

    /// Handles a key the editor knows; returns false for the rest, which then bubble to the app.
    fn handle_key(&mut self, event: &KeyDownEvent) -> bool {
        let control = event.keystroke.modifiers.control;
        let page = self.rows_in_view();
        match event.keystroke.key.as_str() {
            "left" => self.move_horizontally(-1),
            "right" => self.move_horizontally(1),
            "up" => self.move_vertically(-1),
            "down" => self.move_vertically(1),
            "pageup" => self.move_vertically(-(page as isize)),
            "pagedown" => self.move_vertically(page as isize),
            "home" if control => self.move_to(Position::default()),
            "end" if control => self.move_to(Position { row: usize::MAX, column: usize::MAX }),
            "home" => self.move_to(Position { row: self.cursor.row, column: 0 }),
            "end" => self.move_to(Position { row: self.cursor.row, column: usize::MAX }),
            _ => return false,
        }
        true
    }

    /// Moves one character left or right, onto the next line at either end of one.
    fn move_horizontally(&mut self, direction: isize) {
        let Position { row, column } = self.cursor;
        let target = if direction < 0 { self.position_before(row, column) } else { self.position_after(row, column) };
        self.move_to(target);
    }

    /// The position one character before `column`, or the end of the previous line.
    fn position_before(&self, row: usize, column: usize) -> Position {
        if column > 0 {
            return Position { row, column: column - 1 };
        }
        if row == 0 {
            return Position { row, column };
        }
        Position { row: row - 1, column: self.buffer.line_length(row - 1) }
    }

    /// The position one character after `column`, or the start of the next line.
    fn position_after(&self, row: usize, column: usize) -> Position {
        if column < self.buffer.line_length(row) {
            return Position { row, column: column + 1 };
        }
        if row + 1 >= self.buffer.line_count() {
            return Position { row, column };
        }
        Position { row: row + 1, column: 0 }
    }

    /// Moves up or down by some rows, aiming for the goal column.
    fn move_vertically(&mut self, rows: isize) {
        let goal = self.goal_column.unwrap_or(self.cursor.column);
        let row = self.cursor.row.saturating_add_signed(rows);
        self.cursor = self.buffer.clamp(Position { row, column: goal });
        self.goal_column = Some(goal);
        self.scroll_to_cursor();
    }

    /// Puts the cursor at a position, clamped into the buffer.
    fn move_to(&mut self, position: Position) {
        self.cursor = self.buffer.clamp(position);
        self.goal_column = None;
        self.scroll_to_cursor();
    }

    /// Scrolls just enough to bring the cursor's line into view.
    fn scroll_to_cursor(&mut self) {
        let Some(layout) = &self.layout else {
            return;
        };
        let cursor_top = LINE_HEIGHT * self.cursor.row as f32;
        let cursor_bottom = cursor_top + LINE_HEIGHT;
        let view_height = layout.bounds.size.height;
        if cursor_top < self.scroll_top {
            self.scroll_top = cursor_top;
        } else if cursor_bottom > self.scroll_top + view_height {
            self.scroll_top = cursor_bottom - view_height;
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
            "cursor" => Ok(json!({ "row": self.cursor.row, "column": self.cursor.column })),
            _ => Err(CommandError::with_code("UnknownMethod", format!("the editor has no method {method:?}"))),
        }
    }

    fn focus_handle(&self, _cx: &App) -> Option<FocusHandle> {
        Some(self.focus.clone())
    }
}

impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.watch_focus(window, cx);
        div()
            .id("editor")
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(|editor, event: &KeyDownEvent, _window, cx| {
                if !editor.handle_key(event) {
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
                    let Some(layout) = &editor.layout else {
                        return;
                    };
                    let position = layout.position_for_point(event.position);
                    editor.move_to(position);
                    cx.notify();
                }),
            )
            .child(EditorElement { editor: cx.entity() })
    }
}
