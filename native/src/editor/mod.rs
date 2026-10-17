//! The code editor's view, drawn by GPUI and placed in the app as `element("editor")`.
//!
//! What an editor is, and everything that changes it, lives in the `editor_core` crate: an
//! `EditorState` that only `Command`s change, and input layers that turn keys into commands.
//! This view owns one of each and the things only a window has, the scroll offset and the
//! layout of the last frame. It forwards keys and the pointer, applies the commands that come
//! back, scrolls and lets `EditorElement` paint.
//!
//! The view does not own the text. A document, shared through `SharedDocuments`, does, and the
//! view shows the one its `document` prop names, so a view made again, or a second view of the
//! same document, shows the same text, cursors and history. When one view changes a document,
//! the other views of it redraw.

mod completion;
mod documents;
mod element;
mod glide;
mod hover;
mod indent_paint;
mod jump_paint;
mod jump_view;
mod language;
mod occurrence_view;
mod options;
mod popup;
mod signals;
mod smooth_scroll;
mod theme;
mod vim_paint;

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::time::{Duration, Instant};

use editor_core::vim::types::ScrollAlign;
use editor_core::{
    Command, DocumentId, EditorState, InputContext, InputLayer, InputStatus, KeyInput, Modifiers, Outcome, Position,
    SourceFilter, StandardKeymap, VimLayer,
};
use futures::StreamExt;
use serde_json::{Value, json};
use svelte_gpui::gpui::{
    App, Bounds, ClipboardItem, Context, EntityId, EntityInputHandler, FocusHandle, IntoElement, KeyDownEvent,
    Keystroke, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, ScrollWheelEvent,
    Subscription, UTF16Selection, WeakEntity, Window, div, prelude::*, px,
};
use svelte_gpui::{AppElement, CommandError, NativeHost};

pub use documents::{DocumentObserver, SharedDocuments};
pub use signals::{Signal, SignalSender, Signals};

use crate::lsp::LspStore;
use editor_core::display::DisplayRow;
use editor_core::jump::JumpSession;
use element::{EditorElement, LINE_HEIGHT, Layout};
use glide::MIN_GLIDE;
use smooth_scroll::ScrollAnimation;
use theme::EditorTheme;

thread_local! {
    /// Which document each view of the window shows, so a change made in one view can redraw
    /// the others. Views live on the window's thread, so this does too.
    static VIEWS: RefCell<HashMap<EntityId, (DocumentId, WeakEntity<Editor>)>> = RefCell::new(HashMap::new());
    /// The scroll group each view that has one is in, so scrolling one scrolls the rest of its group.
    static SCROLL_GROUPS: RefCell<HashMap<EntityId, (String, WeakEntity<Editor>)>> = RefCell::new(HashMap::new());
}

pub struct Editor {
    documents: SharedDocuments,
    /// The document this view shows, set by the `document` prop; none shows an empty view.
    document: Option<DocumentId>,
    /// This view's entity, once it has been listed in `VIEWS`.
    view: Option<EntityId>,
    focus: FocusHandle,
    /// Turns keys into commands: the standard keymap, or the vim layer when the `keymap` prop says so.
    input: Box<dyn InputLayer>,
    /// The status of the input layer as the app was last told it, so it hears of changes only.
    announced_status: Option<InputStatus>,
    /// The pane this view is in, set by the `pane` prop, so the app can tell whose mode it hears of.
    pane: String,
    /// How far the text is scrolled, in pixels from the top of the first line. Each view of a
    /// document scrolls on its own.
    scroll_top: Pixels,
    /// The glide the view is making to somewhere else, if there is one (see `glide.rs`).
    scroll_animation: Option<ScrollAnimation>,
    /// What the last frame drew; none before the first.
    layout: Option<Layout>,
    /// The last text this editor copied. The system clipboard only takes text from a window that
    /// has focus, so where it refuses, a paste still gets this.
    last_copied: Option<String>,
    /// Whether the left button went down in the editor and is still held, so moving the
    /// pointer extends the newest selection.
    dragging: bool,
    /// The colours the editor paints with, set by the `theme` prop.
    theme: EditorTheme,
    /// The jump labels being shown, if the person is picking a place with them.
    jump: Option<JumpSession>,
    /// Counts the times the cursor may have moved, so a timer that was started before the latest
    /// move knows it is out of date.
    occurrence_generation: u64,
    /// Redraws when focus moves, since the host caches the view and would keep the cursor
    /// as it last drew it.
    focus_subscriptions: Vec<Subscription>,
    /// The language servers, which this view asks for completions, hovers and definitions.
    lsp: LspStore,
    /// Where answers from other threads are sent to reach this view.
    signals: SignalSender,
    /// How the view tells the app about things it cannot do itself, such as opening another file.
    host: NativeHost,
    /// The completion panel, while it is open or waiting for its items.
    completion: Option<completion::Session>,
    /// The hover popover, while it shows or waits for the server.
    hover: Option<hover::Hover>,
    /// Where the pointer last stopped, which turns into a hover if it stays.
    rest: Option<language::PointerRest>,
    hover_timer_armed: bool,
    /// The number the last request was given.
    request_counter: u64,
    /// The go-to-definition request that is out, and its number.
    definition_pending: Option<crate::lsp::Pending>,
    definition_request: u64,
    /// Whether to print how long a keystroke takes to reach the screen, which `GROVE_LATENCY` turns on.
    measure_latency: bool,
    /// The keystroke whose paint has not been timed yet.
    latency_probe: Option<LatencyProbe>,
    /// Whether the view refuses commands that change the text, as the old side of a diff does.
    read_only: bool,
    /// The scroll group this view is in, set by the `scrollGroup` prop; empty for none.
    scroll_group: String,
    /// Which decoration sources this view draws: the ones that are its own (the `viewId` prop)
    /// and every document-wide one except those the `hideSources` prop names.
    sources: SourceFilter,
}

/// When a keystroke that changed the text arrived, and how long the view took to handle it.
struct LatencyProbe {
    pub(super) arrived_at: Instant,
    pub(super) handled: Duration,
}

impl Editor {
    /// A view that shows no document yet; the `document` prop picks one.
    pub fn new(
        documents: SharedDocuments,
        lsp: LspStore,
        signals: &Signals,
        host: NativeHost,
        cx: &mut Context<Self>,
    ) -> Self {
        let (sender, receiver) = signals.subscribe();
        listen_for_signals(receiver, cx);
        Editor {
            documents,
            document: None,
            view: None,
            focus: cx.focus_handle(),
            input: Box::new(StandardKeymap),
            announced_status: None,
            pane: String::new(),
            scroll_top: px(0.0),
            scroll_animation: None,
            layout: None,
            last_copied: None,
            dragging: false,
            theme: EditorTheme::default(),
            jump: None,
            occurrence_generation: 0,
            focus_subscriptions: Vec::new(),
            lsp,
            signals: sender,
            host,
            completion: None,
            hover: None,
            rest: None,
            hover_timer_armed: false,
            request_counter: 0,
            definition_pending: None,
            definition_request: 0,
            measure_latency: std::env::var_os("GROVE_LATENCY").is_some(),
            latency_probe: None,
            read_only: false,
            scroll_group: String::new(),
            sources: SourceFilter::default(),
        }
    }

    /// Shows another document, or none, and remembers which for the other views' sake.
    fn show(&mut self, document: Option<DocumentId>, cx: &mut Context<Self>) {
        self.close_completion();
        self.hover = None;
        self.document = document;
        self.scroll_top = self.remembered_scroll_top(document);
        self.scroll_animation = None;
        self.layout = None;
        self.dragging = false;
        let view = cx.entity_id();
        self.view = Some(view);
        let weak = cx.entity().downgrade();
        VIEWS.with(|views| match document {
            Some(id) => views.borrow_mut().insert(view, (id, weak)),
            None => views.borrow_mut().remove(&view),
        });
    }

    /// Runs `read` over the shown document's state, or gives none while the view shows no open
    /// document. The documents are locked while it runs, so keep it short.
    fn read<R>(&self, read: impl FnOnce(&EditorState) -> R) -> Option<R> {
        let id = self.document?;
        let documents = self.documents.lock();
        let document = documents.get(id)?;
        Some(read(&document.state))
    }

    /// Scrolls this view, and records where the document was left so a view made later starts there.
    fn set_scroll_top(&mut self, scroll_top: Pixels) {
        self.scroll_top = scroll_top;
        let Some(id) = self.document else {
            return;
        };
        if let Some(document) = self.documents.lock().get_mut(id) {
            document.scroll_top = f32::from(scroll_top);
        }
    }

    /// Where the document was last scrolled to, or the top for one that is not open.
    fn remembered_scroll_top(&self, id: Option<DocumentId>) -> Pixels {
        let Some(id) = id else {
            return px(0.0);
        };
        match self.documents.lock().get(id) {
            Some(document) => px(document.scroll_top),
            None => px(0.0),
        }
    }

    /// Applies a command to the shown document and reacts to what it did: scrolls to follow the
    /// newest cursor, puts copied text on the clipboard, and redraws the other views of the
    /// document. The app hears about the effects from the documents. A paste request is filled
    /// in from the clipboard first.
    fn apply(&mut self, command: &Command, cx: &mut Context<Self>) -> Outcome {
        let Some(id) = self.document else {
            return Outcome::default();
        };
        let arrived_at = Instant::now();
        let Some(command) = self.resolve_clipboard(command, cx) else {
            return Outcome::default();
        };
        if self.read_only && command.changes_text() {
            return Outcome::default();
        }
        let Some(outcome) = self.documents.apply(id, &command) else {
            return Outcome::default();
        };
        if let Some(then) = &outcome.jump {
            self.start_jump(then.clone());
        }
        if let Some(rows) = outcome.scroll_rows {
            self.scroll_by_rows(rows);
        }
        if outcome.reveal_newest {
            self.scroll_to_newest();
        }
        if let Some(align) = outcome.scroll {
            self.scroll_newest_to(align);
        }
        if let Some(text) = &outcome.copied {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            self.last_copied = Some(text.clone());
        }
        self.redraw_other_views(id, cx);
        self.track_language_features(&command, &outcome, cx);
        if self.measure_latency && outcome.text_changed {
            self.latency_probe = Some(LatencyProbe { arrived_at, handled: arrived_at.elapsed() });
        }
        if outcome.changed || outcome.text_changed {
            self.occurrences_may_have_changed(cx);
        }
        self.scroll_group_to_here(cx);
        outcome
    }

    /// Puts the views in this view's scroll group at the scroll position this one has.
    fn scroll_group_to_here(&self, cx: &mut Context<Self>) {
        if self.scroll_group.is_empty() {
            return;
        }
        let own = cx.entity_id();
        let scroll_top = self.scroll_top;
        let others: Vec<WeakEntity<Editor>> = SCROLL_GROUPS.with(|groups| {
            let groups = groups.borrow();
            let same_group = groups.iter().filter(|(view, (group, _))| *group == self.scroll_group && **view != own);
            same_group.map(|(_, (_, weak))| weak.clone()).collect()
        });
        for view in others {
            let _ = view.update(cx, |other, cx| {
                other.set_scroll_top(scroll_top);
                cx.notify();
            });
        }
    }

    /// Joins a scroll group, or leaves the one this view is in when the name is empty.
    fn set_scroll_group(&mut self, name: &str, cx: &mut Context<Self>) {
        self.scroll_group = name.to_string();
        let view = cx.entity_id();
        self.view = Some(view);
        let weak = cx.entity().downgrade();
        let group = name.to_string();
        SCROLL_GROUPS.with(|groups| {
            if group.is_empty() {
                groups.borrow_mut().remove(&view);
                return;
            }
            groups.borrow_mut().insert(view, (group, weak));
        });
    }

    /// Redraws every other view of a document, since the host keeps what a view painted until
    /// that view asks to be drawn again.
    fn redraw_other_views(&self, id: DocumentId, cx: &mut Context<Self>) {
        let own = cx.entity_id();
        let others: Vec<WeakEntity<Editor>> = VIEWS.with(|views| {
            let views = views.borrow();
            let showing = views.iter().filter(|(view, (shown, _))| *shown == id && **view != own);
            showing.map(|(_, (_, weak))| weak.clone()).collect()
        });
        for view in others {
            let _ = view.update(cx, |_, cx| cx.notify());
        }
    }

    /// Swaps a request to paste for a paste of the clipboard's text, or of the editor's own last
    /// copy when the clipboard has none, or nothing when there is neither. A vim put from the
    /// clipboard registers (`"+p`) gets the text the same way.
    fn resolve_clipboard(&self, command: &Command, cx: &mut Context<Self>) -> Option<Command> {
        if let Command::Put { register: Some('+' | '*'), clipboard: None, .. } = command {
            let mut resolved = command.clone();
            let text = self.clipboard_text(cx);
            if let Command::Put { clipboard, .. } = &mut resolved {
                *clipboard = text;
            }
            return Some(resolved);
        }
        if *command != Command::PasteClipboard {
            return Some(command.clone());
        }
        let text = self.clipboard_text(cx)?;
        Some(Command::Paste { text })
    }

    /// The clipboard's text, or the editor's own last copy when the clipboard has none.
    fn clipboard_text(&self, cx: &mut Context<Self>) -> Option<String> {
        let clipboard_text = cx.read_from_clipboard().and_then(|item| item.text());
        clipboard_text.or_else(|| self.last_copied.clone())
    }

    /// Handles a key the input layer knows; returns false for the rest, which then bubble to the app.
    fn handle_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        if self.jump.is_some() {
            return self.jump_key(keystroke, cx);
        }
        self.hide_hover(cx);
        if self.completion_key(keystroke, cx) {
            return true;
        }
        let context = InputContext { page_rows: self.rows_in_view(), top_row: self.top_row() };
        let commands = self.input.translate(&key_input(keystroke), &context);
        self.announce_status();
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

    /// The first buffer row that is fully in view, which vim's `H` goes to.
    fn top_row(&self) -> usize {
        let Some(layout) = &self.layout else {
            return 0;
        };
        let mut display_row = (self.scroll_target() / LINE_HEIGHT).ceil() as usize;
        loop {
            match layout.blocks.row_at(display_row) {
                DisplayRow::Text(row) => return row,
                DisplayRow::Block { .. } => display_row += 1,
            }
        }
    }

    /// Tells the app the input layer's mode and pending keys when they changed, for the status bar.
    fn announce_status(&mut self) {
        let status = self.input.status();
        if self.announced_status.as_ref() == Some(&status) {
            return;
        }
        self.documents.announce(
            "editor-mode",
            json!({
                "pane": self.pane,
                "mode": status.mode,
                "pending": status.pending,
                "commandLine": status.command_line,
            }),
        );
        self.announced_status = Some(status);
    }

    /// Switches between the standard keymap and vim.
    fn set_keymap(&mut self, name: &str) {
        self.input = match name {
            "vim" => Box::new(VimLayer::new()),
            _ => Box::new(StandardKeymap),
        };
        self.announce_status();
    }

    /// Scrolls so the newest cursor's row is at the top, middle or bottom of the view.
    fn scroll_newest_to(&mut self, align: ScrollAlign) {
        let Some(layout) = &self.layout else {
            return;
        };
        let Some(head_row) = self.read(|state| state.selections().newest().head.row) else {
            return;
        };
        let head_top = LINE_HEIGHT * layout.blocks.display_row_of(head_row) as f32;
        let view_height = layout.bounds.size.height;
        let target = match align {
            ScrollAlign::Top => head_top,
            ScrollAlign::Center => head_top - (view_height - LINE_HEIGHT) / 2.0,
            ScrollAlign::Bottom => head_top + LINE_HEIGHT - view_height,
        };
        self.scroll_to(target.max(px(0.0)), MIN_GLIDE);
    }

    /// A press of the left button: a click places one cursor, Alt-click adds or removes one,
    /// Shift-click extends the newest selection, and a double click selects a word.
    fn press(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        self.jump = None;
        let Some(at) = self.position_at(event.position) else {
            return;
        };
        self.hide_hover(cx);
        self.close_completion();
        self.dragging = true;
        if event.modifiers.control && !event.modifiers.shift && !event.modifiers.alt {
            self.apply(&Command::PlaceCursor { at }, cx);
            self.clamp_cursors_in_normal_mode(cx);
            self.go_to_definition_at(at, cx);
            return;
        }
        if event.modifiers.shift {
            self.apply(&Command::ExtendNewestTo { at }, cx);
            return;
        }
        if event.modifiers.alt {
            self.apply(&Command::ToggleCursor { at }, cx);
            self.clamp_cursors_in_normal_mode(cx);
            return;
        }
        self.apply(&Command::PlaceCursor { at }, cx);
        if event.click_count == 2 {
            self.apply(&Command::SelectWordAt { at }, cx);
            return;
        }
        self.clamp_cursors_in_normal_mode(cx);
    }

    /// Vim's normal mode has no place for the cursor after a line's last character, which a click
    /// past the end of the line puts it at, so it is moved back onto the character.
    fn clamp_cursors_in_normal_mode(&mut self, cx: &mut Context<Self>) {
        if self.input.status().mode != "NORMAL" {
            return;
        }
        self.apply(&Command::ClampCursors, cx);
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
        let Some(head_row) = self.read(|state| state.selections().newest().head.row) else {
            return;
        };
        let head_top = LINE_HEIGHT * layout.blocks.display_row_of(head_row) as f32;
        let head_bottom = head_top + LINE_HEIGHT;
        let view_height = layout.bounds.size.height;
        let scroll_top = self.scroll_target();
        if head_top < scroll_top {
            self.scroll_to(head_top, MIN_GLIDE);
        } else if head_bottom > scroll_top + view_height {
            self.scroll_to(head_bottom - view_height, MIN_GLIDE);
        }
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

/// Handles what other threads send the view, on the window's thread, until the view is gone.
fn listen_for_signals(mut receiver: futures::channel::mpsc::UnboundedReceiver<Signal>, cx: &mut Context<Editor>) {
    cx.spawn(async move |editor, cx| {
        while let Some(signal) = receiver.next().await {
            let handled = editor.update(cx, |editor, cx| editor.handle_signal(signal, cx));
            if handled.is_err() {
                return;
            }
        }
    })
    .detach();
}

impl Editor {
    /// Reacts to something another thread sent: a document that was decorated, or an answer from
    /// a language server.
    fn handle_signal(&mut self, signal: Signal, cx: &mut Context<Self>) {
        match signal {
            Signal::Redraw(document) => {
                if self.document == Some(document) {
                    cx.notify();
                }
            }
            Signal::Completions { request, result } => self.completions_arrived(request, result, cx),
            Signal::Resolved { request, item } => self.item_resolved(request, item, cx),
            Signal::Hover { request, markdown } => self.hover_arrived(request, markdown, cx),
            Signal::Targets { request, targets } => self.targets_arrived(request, targets, cx),
        }
    }
}

impl Drop for Editor {
    /// Forgets the view, so a change to its document does not redraw it any more.
    fn drop(&mut self) {
        let Some(view) = self.view else {
            return;
        };
        let _ = VIEWS.try_with(|views| views.borrow_mut().remove(&view));
        let _ = SCROLL_GROUPS.try_with(|groups| groups.borrow_mut().remove(&view));
    }
}

/// A GPUI keystroke as the input layers see it.
fn key_input(keystroke: &Keystroke) -> KeyInput {
    let modifiers = keystroke.modifiers;
    if let Some(character) = typed_character(keystroke) {
        return KeyInput { key: character, modifiers: Modifiers { control: false, alt: false, shift: false } };
    }
    KeyInput {
        key: keystroke.key.clone(),
        modifiers: Modifiers { control: modifiers.control, alt: modifiers.alt, shift: modifiers.shift },
    }
}

/// The character a key types, as the key itself, so a layer sees `$` and `A` rather than
/// Shift and `4` or `a`. Keys with Control or Alt held, white space and the named keys
/// (`enter`, `left`) are not characters.
fn typed_character(keystroke: &Keystroke) -> Option<String> {
    let modifiers = keystroke.modifiers;
    if modifiers.control || modifiers.alt || modifiers.platform {
        return None;
    }
    let text = keystroke.key_char.as_ref()?;
    let mut characters = text.chars();
    let character = characters.next()?;
    if characters.next().is_some() || character.is_control() || character.is_whitespace() {
        return None;
    }
    Some(text.clone())
}

impl AppElement for Editor {
    /// The `document` prop is the id of the document to show; removing it empties the view. The
    /// `theme` prop carries the colours to paint with (see `theme.rs`).
    fn set_prop(&mut self, name: &str, value: Value, cx: &mut Context<Self>) {
        if name == "theme" {
            self.theme = EditorTheme::from_json(&value);
            return;
        }
        if name == "readonly" {
            self.read_only = value.as_bool().unwrap_or(false);
            return;
        }
        if name == "viewId" {
            self.sources.view = value.as_str().unwrap_or("").to_string();
            cx.notify();
            return;
        }
        if name == "hideSources" {
            let names = value.as_array().into_iter().flatten().filter_map(Value::as_str);
            self.sources.hidden = names.map(str::to_string).collect();
            cx.notify();
            return;
        }
        if name == "scrollGroup" {
            self.set_scroll_group(value.as_str().unwrap_or(""), cx);
            return;
        }
        if name == "pane" {
            self.pane = value.as_str().unwrap_or("").to_string();
            self.announced_status = None;
            return;
        }
        if name == "keymap" {
            self.set_keymap(value.as_str().unwrap_or("standard"));
            cx.notify();
            return;
        }
        if name != "document" {
            return;
        }
        let document = value.as_u64();
        if document == self.document {
            return;
        }
        self.show(document, cx);
    }

    fn call(&mut self, method: &str, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        match method {
            "selections" => Ok(self.selections_json()),
            "apply" => self.apply_from_app(args, cx),
            "refresh" => {
                cx.notify();
                Ok(Value::Null)
            }
            "hover" => {
                self.hover_at_cursor(cx);
                Ok(Value::Null)
            }
            "definition" => {
                if let Some(head) = self.read(|state| state.selections().newest().head) {
                    self.go_to_definition_at(head, cx);
                }
                Ok(Value::Null)
            }
            "complete" => {
                self.start_completion(completion::Trigger::Invoked, cx);
                Ok(Value::Null)
            }
            "goto" => self.goto_from_app(args, cx),
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

    /// The `goto` method: puts the cursor at a line and UTF-16 column, counted from zero, and
    /// scrolls to it, as the app does after opening the file a definition is in.
    fn goto_from_app(&mut self, args: Value, cx: &mut Context<Self>) -> Result<Value, CommandError> {
        let line = args.get(0).and_then(Value::as_u64);
        let character = args.get(1).and_then(Value::as_u64);
        let (Some(line), Some(character)) = (line, character) else {
            return Err(CommandError::with_code("InvalidArguments", "goto takes a line and a column"));
        };
        self.go_to(line as usize, character as usize, cx);
        Ok(Value::Null)
    }

    /// Every selection as the app sees it.
    fn selections_json(&self) -> Value {
        let selections = self.read(|state| state.selections().all().iter().map(selection_json).collect::<Vec<_>>());
        json!(selections.unwrap_or_default())
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
                editor.hide_hover(cx);
                editor.jump = None;
                editor.wheel_scrolled(event.delta);
                editor.occurrences_may_have_changed(cx);
                editor.scroll_group_to_here(cx);
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
                    return;
                }
                if event.pressed_button.is_none() {
                    editor.pointer_moved(event.position, cx);
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
        let (text, adjusted_range) = self.read(|state| {
            let buffer = state.buffer();
            let (start, end) = (buffer.offset_of_utf16(range.start), buffer.offset_of_utf16(range.end));
            (buffer.slice(start..end), buffer.utf16_of_offset(start)..buffer.utf16_of_offset(end))
        })?;
        *adjusted = Some(adjusted_range);
        Some(text)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        self.read(|state| {
            let newest = state.selections().newest();
            let buffer = state.buffer();
            let anchor = buffer.utf16_of_offset(buffer.offset_of(newest.anchor));
            let head = buffer.utf16_of_offset(buffer.offset_of(newest.head));
            UTF16Selection { range: anchor.min(head)..anchor.max(head), reversed: head < anchor }
        })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        self.read(|state| {
            let (start, end) = state.marked_range()?;
            Some(utf16_range(state, start, end))
        })?
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
        let position = self.read(|state| state.buffer().position_of(state.buffer().offset_of_utf16(range.start)))?;
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
        self.read(|state| state.buffer().utf16_of_offset(state.buffer().offset_of(position)))
    }
}

impl Editor {
    /// The command for an input method's request to put text over a UTF-16 range. Text that goes
    /// where the cursors are, or over the composed text, is typed at every cursor; a range
    /// elsewhere replaces just that range.
    fn command_for_replacing(&self, range: Option<Range<usize>>, text: &str) -> Command {
        let typing = Command::InsertText { text: text.to_string() };
        let Some(range) = range else {
            return typing;
        };
        let replaces_elsewhere = self.read(|state| {
            let newest = state.selections().newest();
            let at_selection = range == utf16_range(state, newest.start(), newest.end());
            let at_composition = match state.marked_range() {
                Some((start, end)) => range == utf16_range(state, start, end),
                None => false,
            };
            if at_selection || at_composition {
                return None;
            }
            let buffer = state.buffer();
            Some((buffer.offset_of_utf16(range.start), buffer.offset_of_utf16(range.end)))
        });
        match replaces_elsewhere.flatten() {
            Some((start, end)) => Command::ReplaceRange { start, end, text: text.to_string() },
            None => typing,
        }
    }
}

/// The UTF-16 range between two positions.
fn utf16_range(state: &EditorState, start: Position, end: Position) -> Range<usize> {
    let buffer = state.buffer();
    buffer.utf16_of_offset(buffer.offset_of(start))..buffer.utf16_of_offset(buffer.offset_of(end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keystroke(key: &str, key_char: Option<&str>, shift: bool, control: bool) -> Keystroke {
        let mut keystroke =
            Keystroke { key: key.to_string(), key_char: key_char.map(str::to_string), ..Keystroke::default() };
        keystroke.modifiers.shift = shift;
        keystroke.modifiers.control = control;
        keystroke
    }

    #[test]
    fn a_typed_key_is_the_character_it_types() {
        assert_eq!(key_input(&keystroke("4", Some("$"), true, false)).key, "$");
        assert_eq!(key_input(&keystroke("a", Some("A"), true, false)).key, "A");
        assert!(!key_input(&keystroke("a", Some("A"), true, false)).modifiers.shift);
    }

    #[test]
    fn named_keys_and_control_chords_stay_as_they_are() {
        assert_eq!(key_input(&keystroke("enter", Some("\n"), false, false)).key, "enter");
        assert_eq!(key_input(&keystroke("space", Some(" "), false, false)).key, "space");
        let chord = key_input(&keystroke("d", None, false, true));
        assert_eq!(chord.key, "d");
        assert!(chord.modifiers.control);
    }
}
