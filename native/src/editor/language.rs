//! What the editor view does with language servers: opens the completion panel as the person
//! types and keeps it narrowed, accepts an item at every cursor, shows hovers and diagnostics
//! where the pointer rests, and goes to definitions.
//!
//! Everything a server answers arrives as a `Signal` on the window's thread, so the view changes
//! between frames and never waits for a server; the one exception is accepting an item that has
//! not been resolved yet, which waits a moment so its extra edits are not lost.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use editor_core::{Bias, Command, Outcome, Position, Tone};
use lsp_client::completion::{Item, parse_items};
use lsp_client::markdown::contents_to_markdown;
use lsp_client::protocol::{Severity, Target, parse_targets};
use lsp_client::uri::path_from_uri;
use serde_json::{Value, json};
use svelte_gpui::gpui::{Context, Keystroke, Pixels, Point};

use super::completion::{
    Session, Trigger, is_word_character, plan_acceptance, query_ends_session, word_opens_panel, word_start,
};
use super::hover::{HOVER_DELAY_MILLISECONDS, Hover, HoverDiagnostic, word_range_at};
use super::{Editor, Signal};

/// How long accepting an item waits for the server to resolve it, at most.
const RESOLVE_ON_ACCEPT: Duration = Duration::from_millis(300);

/// What the pointer last did: where it came to rest, and when it moved there.
pub struct PointerRest {
    position: Position,
    moved_at: Instant,
}

impl Editor {
    /// A number for a request, so its answer can be told from the answers to older ones.
    pub(super) fn next_request_number(&mut self) -> u64 {
        self.request_counter += 1;
        self.request_counter
    }

    /// Reacts to what a command did: typing opens and narrows the completion panel, moving the
    /// cursor out of the word closes it, and any change to the text takes a hover away.
    pub(super) fn track_language_features(&mut self, command: &Command, outcome: &Outcome, cx: &mut Context<Self>) {
        if outcome.text_changed {
            self.hover = None;
            self.hints_are_stale(cx);
        }
        self.track_signature(command, outcome, cx);
        if !self.is_typing_mode() {
            self.close_completion();
            return;
        }
        match command {
            Command::InsertText { text } if outcome.text_changed => self.completion_typed(text, cx),
            Command::Delete { .. } if outcome.text_changed => self.revalidate_completion(cx),
            Command::InsertCompletion { .. } | Command::SnippetNext | Command::SnippetPrevious => {
                self.close_completion();
            }
            _ if outcome.changed || outcome.text_changed => self.revalidate_completion(cx),
            _ => {}
        }
    }

    /// Text was typed: opens the panel at a word or a trigger character, or narrows it.
    fn completion_typed(&mut self, text: &str, cx: &mut Context<Self>) {
        self.revalidate_completion(cx);
        let mut characters = text.chars();
        let (Some(character), None) = (characters.next(), characters.next()) else {
            self.close_completion();
            return;
        };
        if self.completion.is_some() {
            let incomplete = self.completion.as_ref().is_some_and(|session| session.is_incomplete);
            if incomplete && is_word_character(character) {
                self.ask_again_for_completions();
            }
            return;
        }
        let Some(document) = self.document else {
            return;
        };
        let Some(capabilities) = self.lsp.capabilities(document) else {
            return;
        };
        if !capabilities.completion {
            return;
        }
        let is_trigger = capabilities.trigger_characters.iter().any(|trigger| trigger.chars().eq([character]));
        if is_trigger {
            self.start_completion(Trigger::Character(character), cx);
            return;
        }
        let opens = self.read(|state| {
            let head = state.selections().newest().head;
            word_opens_panel(&state.buffer().line(head.row), head.column)
        });
        if opens == Some(true) && is_word_character(character) {
            self.start_completion(Trigger::Typing, cx);
        }
    }

    /// Asks the server for items at the cursor and opens the panel when they come.
    pub(super) fn start_completion(&mut self, trigger: Trigger, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        if self.read_only {
            return;
        }
        let Some(capabilities) = self.lsp.capabilities(document) else {
            return;
        };
        if !capabilities.completion {
            return;
        }
        let Some((head, line)) = self.read(|state| {
            let head = state.selections().newest().head;
            (head, state.buffer().line(head.row))
        }) else {
            return;
        };
        self.close_completion();
        let start = Position { row: head.row, column: word_start(&line, head.column) };
        let anchor = self.documents.lock().get_mut(document).map(|doc| doc.state.create_anchor(start, Bias::Left));
        let Some(anchor) = anchor else {
            return;
        };
        let request = self.next_request_number();
        let pending = self.request_completions(document, head, trigger, request);
        let Some(pending) = pending else {
            self.remove_anchor(document, anchor);
            return;
        };
        self.completion = Some(Session::new(document, anchor, request, pending));
        cx.notify();
    }

    /// Sends the completion request for a place, whose answer comes back as a signal.
    fn request_completions(
        &mut self,
        document: u64,
        head: Position,
        trigger: Trigger,
        request: u64,
    ) -> Option<crate::lsp::Pending> {
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, lsp_client::protocol::ResponseError>| {
            let result = result.map(|answer| parse_items(&answer)).map_err(|error| error.message);
            let _ = sender.unbounded_send(Signal::Completions { request, result });
        });
        self.lsp.request_at(document, head, "textDocument/completion", completion_context(trigger), reply)
    }

    /// Asks again at the same place, as a server that gave an incomplete list wants.
    fn ask_again_for_completions(&mut self) {
        let Some(session) = &self.completion else {
            return;
        };
        let document = session.document;
        let Some(head) = self.read(|state| state.selections().newest().head) else {
            return;
        };
        let request = self.next_request_number();
        let pending = self.request_completions(document, head, Trigger::Invoked, request);
        if let (Some(session), Some(pending)) = (&mut self.completion, pending) {
            if let Some(old) = session.pending.replace(pending) {
                old.cancel();
            }
            session.request = request;
        }
    }

    /// Takes in the items of an answer, if it is the one being waited for.
    pub(super) fn completions_arrived(
        &mut self,
        request: u64,
        result: Result<lsp_client::completion::ItemList, String>,
        cx: &mut Context<Self>,
    ) {
        let Some(session) = &mut self.completion else {
            return;
        };
        if session.request != request {
            return;
        }
        session.pending = None;
        let Ok(list) = result else {
            self.close_completion();
            cx.notify();
            return;
        };
        session.items = list.items;
        session.is_incomplete = list.is_incomplete;
        session.resolved.clear();
        session.resolving.clear();
        let query = session.query.clone();
        session.filter(&query);
        self.revalidate_completion(cx);
        self.resolve_selected_item();
        cx.notify();
    }

    /// Closes the panel unless the cursor is still in the word it was opened for, then narrows it.
    fn revalidate_completion(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.completion else {
            return;
        };
        let (document, anchor) = (session.document, session.start);
        let query = self.read(|state| {
            let selection = state.selections().newest();
            let start = state.anchor_position(anchor)?;
            let buffer = state.buffer();
            let still_in_word = selection.is_empty() && selection.head.row == start.row && selection.head >= start;
            if !still_in_word {
                return None;
            }
            Some(buffer.text_between(start, selection.head))
        });
        let query = query.flatten();
        let Some(query) = query.filter(|query| !query_ends_session(query)) else {
            self.close_completion();
            cx.notify();
            return;
        };
        if self.document != Some(document) {
            self.close_completion();
            return;
        }
        let Some(session) = &mut self.completion else {
            return;
        };
        if session.query != query {
            session.filter(&query);
            self.resolve_selected_item();
        }
        cx.notify();
    }

    /// Closes the panel and lets go of what it held.
    pub(super) fn close_completion(&mut self) {
        let Some(session) = self.completion.take() else {
            return;
        };
        if let Some(pending) = &session.pending {
            pending.cancel();
        }
        self.remove_anchor(session.document, session.start);
    }

    /// Stops keeping an anchor up to date.
    fn remove_anchor(&self, document: u64, anchor: editor_core::AnchorId) {
        if let Some(doc) = self.documents.lock().get_mut(document) {
            doc.state.remove_anchor(anchor);
        }
    }

    /// Asks the server for more about the selected item, once, so its documentation can show beside it.
    pub(super) fn resolve_selected_item(&mut self) {
        let Some(session) = &self.completion else {
            return;
        };
        let (Some(index), Some(item)) = (session.selected_index(), session.selected_item()) else {
            return;
        };
        if session.resolved.contains(&index) || session.resolving.values().any(|pending| *pending == index) {
            return;
        }
        let document = session.document;
        let raw = item.raw.clone();
        let Some(capabilities) = self.lsp.capabilities(document) else {
            return;
        };
        if !capabilities.completion_resolve {
            return;
        }
        let request = self.next_request_number();
        let sender = self.signals.clone();
        // A failed request, such as one the server cancels because the text changed, is reported as a
        // null item, so the item can be asked about again the next time it is selected.
        let reply = Box::new(move |result: Result<Value, lsp_client::protocol::ResponseError>| {
            let item = result.unwrap_or(Value::Null);
            let _ = sender.unbounded_send(Signal::Resolved { request, item });
        });
        self.lsp.request_for(document, "completionItem/resolve", raw, reply);
        if let Some(session) = &mut self.completion {
            session.resolving.insert(request, index);
        }
    }

    /// Takes in a resolved item.
    pub(super) fn item_resolved(&mut self, request: u64, resolved: Value, cx: &mut Context<Self>) {
        let Some(session) = &mut self.completion else {
            return;
        };
        let Some(index) = session.resolving.remove(&request) else {
            return;
        };
        if resolved.is_null() {
            cx.notify();
            return;
        }
        if let Some(item) = session.items.get_mut(index) {
            item.merge_resolved(&resolved);
            session.resolved.push(index);
        }
        cx.notify();
    }

    /// Handles a key while the panel is open, or the keys that open it. Returns whether it used the key.
    pub(super) fn completion_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        let key = keystroke.key.as_str();
        let modifiers = keystroke.modifiers;
        let typing = self.is_typing_mode();
        if key == "space" && modifiers.control && !modifiers.alt && typing {
            self.start_completion(Trigger::Invoked, cx);
            return true;
        }
        let visible = self.completion.as_ref().is_some_and(Session::is_visible);
        if !visible {
            return self.snippet_key(keystroke, cx);
        }
        let step = match (key, modifiers.control, modifiers.shift) {
            ("down", false, false) | ("n", true, false) => 1,
            ("up", false, false) | ("p", true, false) => -1,
            ("pagedown", false, false) => super::completion::VISIBLE_ROWS as isize,
            ("pageup", false, false) => -(super::completion::VISIBLE_ROWS as isize),
            ("tab" | "enter", false, false) => return self.accept_completion(cx),
            ("escape", false, false) => {
                self.close_completion();
                cx.notify();
                // Vim's Escape ends insert mode as well, the same press, so it goes on to the layer.
                return typing && self.input.status().mode.is_empty();
            }
            _ => return false,
        };
        if let Some(session) = &mut self.completion {
            session.move_selection(step);
        }
        self.resolve_selected_item();
        cx.notify();
        true
    }

    /// Whether typed keys go into the text: always with the standard keymap, and in vim's insert
    /// mode. Completion does not open or take keys in any other mode.
    pub(super) fn is_typing_mode(&self) -> bool {
        let mode = self.input.status().mode;
        mode.is_empty() || mode == "INSERT"
    }

    /// Tab and Shift-Tab move between the stops of a snippet that was just completed.
    fn snippet_key(&mut self, keystroke: &Keystroke, cx: &mut Context<Self>) -> bool {
        if keystroke.key != "tab" || keystroke.modifiers.control || keystroke.modifiers.alt || !self.is_typing_mode() {
            return false;
        }
        if self.read(|state| state.in_snippet()) != Some(true) {
            return false;
        }
        let command = if keystroke.modifiers.shift { Command::SnippetPrevious } else { Command::SnippetNext };
        self.apply(&command, cx);
        cx.notify();
        true
    }

    /// Accepts the item of a row that was clicked.
    pub(super) fn accept_completion_row(&mut self, position: usize, cx: &mut Context<Self>) {
        if let Some(session) = &mut self.completion {
            session.select(position);
        }
        self.accept_completion(cx);
    }

    /// Puts the selected item in the text at every cursor, with the edits it makes elsewhere.
    pub(super) fn accept_completion(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(session) = self.completion.take() else {
            return false;
        };
        let Some(item) = session.selected_item().cloned() else {
            self.completion = Some(session);
            return false;
        };
        let item = self.resolved_for_accepting(&session, item);
        let planned = self.read(|state| {
            let start = state.anchor_position(session.start)?;
            let head = state.selections().newest().head;
            Some(plan_acceptance(state.buffer(), head, start, &item))
        });
        if let Some(pending) = &session.pending {
            pending.cancel();
        }
        let Some(Some(acceptance)) = planned else {
            self.remove_anchor(session.document, session.start);
            return false;
        };
        let command = Command::InsertCompletion {
            before: acceptance.before,
            after: acceptance.after,
            text: acceptance.text,
            snippet: acceptance.snippet,
            additional: acceptance.additional,
        };
        self.apply(&command, cx);
        self.remove_anchor(session.document, session.start);
        cx.notify();
        true
    }

    /// The item with what resolving adds, waiting briefly for the server when it has not been
    /// resolved, since edits like an import only come with it.
    fn resolved_for_accepting(&mut self, session: &Session, mut item: Item) -> Item {
        let Some(index) = session.selected_index() else {
            return item;
        };
        let Some(capabilities) = self.lsp.capabilities(session.document) else {
            return item;
        };
        if session.resolved.contains(&index) || !capabilities.completion_resolve {
            return item;
        }
        let (sender, receiver) = mpsc::channel();
        let reply = Box::new(move |result: Result<Value, lsp_client::protocol::ResponseError>| {
            let _ = sender.send(result);
        });
        let pending = self.lsp.request_for(session.document, "completionItem/resolve", item.raw.clone(), reply);
        if pending.is_none() {
            return item;
        }
        if let Ok(Ok(resolved)) = receiver.recv_timeout(RESOLVE_ON_ACCEPT) {
            item.merge_resolved(&resolved);
        }
        item
    }

    // ---- hover

    /// The pointer moved over text without a button held.
    pub(super) fn pointer_moved(&mut self, point: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(layout) = &self.layout else {
            return;
        };
        if layout.over_minimap(point) || !layout.over_text(point) {
            self.rest = None;
            self.hide_hover(cx);
            return;
        }
        let position = layout.position_for_point(point);
        if let Some(hover) = &self.hover {
            if hover.contains(position) {
                return;
            }
            self.hide_hover(cx);
        }
        if self.rest.as_ref().is_some_and(|rest| rest.position == position) {
            return;
        }
        self.rest = Some(PointerRest { position, moved_at: Instant::now() });
        self.arm_hover_timer(Duration::from_millis(HOVER_DELAY_MILLISECONDS), cx);
    }

    /// Waits, then looks again at whether the pointer has rested long enough.
    fn arm_hover_timer(&mut self, delay: Duration, cx: &mut Context<Self>) {
        if self.hover_timer_armed {
            return;
        }
        self.hover_timer_armed = true;
        cx.spawn(async move |editor, cx| {
            cx.background_executor().timer(delay).await;
            let _ = editor.update(cx, |editor, cx| editor.hover_timer_fired(cx));
        })
        .detach();
    }

    /// The timer ran out: shows the hover if the pointer has not moved since, else waits for the rest.
    fn hover_timer_fired(&mut self, cx: &mut Context<Self>) {
        self.hover_timer_armed = false;
        let Some(rest) = &self.rest else {
            return;
        };
        let rested = rest.moved_at.elapsed();
        let wanted = Duration::from_millis(HOVER_DELAY_MILLISECONDS);
        if rested < wanted {
            self.arm_hover_timer(wanted - rested, cx);
            return;
        }
        let position = rest.position;
        self.rest = None;
        self.show_hover_at(position, cx);
    }

    /// Hides the hover, if there is one.
    pub(super) fn hide_hover(&mut self, cx: &mut Context<Self>) {
        let Some(hover) = self.hover.take() else {
            return;
        };
        if let Some(pending) = &hover.pending {
            pending.cancel();
        }
        cx.notify();
    }

    /// Shows what is known about the word at a position: its diagnostics now, the server's
    /// hover when it answers.
    pub(super) fn show_hover_at(&mut self, position: Position, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        let sources = self.sources.clone();
        let found = self.read(|state| {
            let range = word_range_at(&state.buffer().line(position.row), position.row, position.column)?;
            Some((range, diagnostics_at(state, position, &sources)))
        });
        let Some(Some((range, diagnostics))) = found else {
            return;
        };
        self.hide_hover(cx);
        let request = self.next_request_number();
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, lsp_client::protocol::ResponseError>| {
            let markdown = match result {
                Ok(answer) => hover_markdown(&answer),
                Err(_) => None,
            };
            let _ = sender.unbounded_send(Signal::Hover { request, markdown });
        });
        let capabilities = self.lsp.capabilities(document);
        let wants_hover = capabilities.is_some_and(|capabilities| capabilities.hover);
        let pending = if wants_hover {
            self.lsp.request_at(document, position, "textDocument/hover", json!({}), reply)
        } else {
            None
        };
        let waiting = pending.is_some();
        let hover = Hover { range, diagnostics, markdown: None, request, waiting, pending };
        if hover.has_content() || waiting {
            self.hover = Some(hover);
            cx.notify();
        }
    }

    /// The server's answer to a hover request.
    pub(super) fn hover_arrived(&mut self, request: u64, markdown: Option<String>, cx: &mut Context<Self>) {
        let Some(hover) = &mut self.hover else {
            return;
        };
        if hover.request != request {
            return;
        }
        hover.waiting = false;
        hover.pending = None;
        hover.markdown = markdown;
        if !hover.has_content() {
            self.hover = None;
        }
        cx.notify();
    }

    /// Shows the hover at the newest cursor, as Ctrl-K Ctrl-I does.
    pub(super) fn hover_at_cursor(&mut self, cx: &mut Context<Self>) {
        let Some(head) = self.read(|state| state.selections().newest().head) else {
            return;
        };
        self.show_hover_at(head, cx);
    }

    // ---- definitions

    /// Asks the server where the symbol at a position is defined.
    pub(super) fn go_to_definition_at(&mut self, position: Position, cx: &mut Context<Self>) {
        self.go_to_at(position, "textDocument/definition", cx);
    }

    /// Goes to the type or the implementations of the symbol at the cursor.
    pub(super) fn go_to_cursor_with(&mut self, method: &'static str, title: &'static str, cx: &mut Context<Self>) {
        self.targets_title = title;
        if let Some(head) = self.cursor() {
            self.go_to_at(head, method, cx);
        }
    }

    /// Asks the server where a request about the symbol at a position leads.
    fn go_to_at(&mut self, position: Position, method: &str, cx: &mut Context<Self>) {
        let Some(document) = self.document else {
            return;
        };
        let request = self.next_request_number();
        let sender = self.signals.clone();
        let reply = Box::new(move |result: Result<Value, lsp_client::protocol::ResponseError>| {
            let targets = match result {
                Ok(answer) => parse_targets(&answer),
                Err(_) => Vec::new(),
            };
            let _ = sender.unbounded_send(Signal::Targets { request, targets });
        });
        if let Some(previous) = self.definition_pending.take() {
            previous.cancel();
        }
        self.definition_pending = self.lsp.request_at(document, position, method, json!({}), reply);
        self.definition_request = request;
        cx.notify();
    }

    /// Goes to where a definition request led: in this document by moving the cursor, in another
    /// by asking the app to open it.
    pub(super) fn targets_arrived(&mut self, request: u64, targets: Vec<Target>, cx: &mut Context<Self>) {
        if request != self.definition_request {
            return;
        }
        self.definition_pending = None;
        let title = std::mem::replace(&mut self.targets_title, "Definitions");
        if targets.len() > 1 {
            let items = super::menu::location_items(&self.documents, &targets);
            self.show_locations(title, items, cx);
            return;
        }
        let Some(target) = targets.first() else {
            self.notice(&format!("No {} found", title.to_lowercase()));
            return;
        };
        let Some(path) = path_from_uri(&target.uri) else {
            return;
        };
        let line = target.range.start.line;
        let character = target.range.start.character;
        let own_path = self.read(|state| state.buffer().path().map(|path| path.to_path_buf())).flatten();
        if own_path.as_deref() == Some(path.as_path()) {
            self.go_to(line, character, cx);
            return;
        }
        let event = json!({ "path": path.display().to_string(), "line": line, "character": character });
        self.host.emit("goto", event);
    }

    /// Puts the cursor at a line and UTF-16 column of the shown document, and scrolls to it.
    pub(super) fn go_to(&mut self, line: usize, character: usize, cx: &mut Context<Self>) {
        let at = self.read(|state| {
            let buffer = state.buffer();
            let offset = buffer.offset_of_utf16_point(editor_core::Utf16Point { line, character });
            buffer.position_of(offset)
        });
        let Some(at) = at else {
            return;
        };
        self.apply(&Command::PlaceCursor { at }, cx);
        self.center_on(at.row);
        self.pending_center = Some(at.row);
        cx.notify();
    }

    /// Centres the row `go_to` asked for, now that a frame has laid the shown document out. Does
    /// nothing, and draws no extra frame, when no `go_to` is waiting.
    pub(super) fn center_pending_row(&mut self, cx: &mut Context<Self>) {
        let Some(row) = self.pending_center.take() else {
            return;
        };
        self.center_on(row);
        cx.notify();
    }

    /// Scrolls so a row is in the middle of the view, as far as the text allows.
    fn center_on(&mut self, row: usize) {
        let Some(layout) = &self.layout else {
            return;
        };
        let row_top = super::element::LINE_HEIGHT * layout.blocks.display_row_of(row) as f32;
        let half_view = layout.bounds.size.height / 2.0;
        let target = (row_top - half_view).max(Pixels::ZERO);
        self.set_scroll_top(target);
    }
}

/// The `context` of a completion request for what opened the panel.
fn completion_context(trigger: Trigger) -> Value {
    match trigger {
        Trigger::Character(character) => {
            json!({ "context": { "triggerKind": 2, "triggerCharacter": character.to_string() } })
        }
        Trigger::Typing | Trigger::Invoked => json!({ "context": { "triggerKind": 1 } }),
    }
}

/// The text of a hover answer as markdown, or none when it says nothing.
fn hover_markdown(answer: &Value) -> Option<String> {
    let contents = answer.get("contents")?;
    let markdown = contents_to_markdown(contents);
    if markdown.trim().is_empty() {
        return None;
    }
    Some(markdown)
}

/// The diagnostics whose range covers a position, among the decorations the view shows.
fn diagnostics_at(
    state: &editor_core::EditorState,
    position: Position,
    sources: &editor_core::SourceFilter,
) -> Vec<HoverDiagnostic> {
    let rows = position.row..position.row + 1;
    let mut found = Vec::new();
    for placed in state.decorations_in_rows_for(rows, sources) {
        let Some(tooltip) = placed.tooltip else {
            continue;
        };
        let tone = match placed.kind {
            editor_core::DecorationKind::Highlight { underline: Some(underline), .. } => underline.tone,
            _ => Tone::Info,
        };
        if placed.start <= position && position <= placed.end {
            found.push(HoverDiagnostic { tone, message: tooltip.to_string() });
        }
    }
    found
}

/// How bad a tone is, which orders the diagnostics of a hover with the worst first.
pub fn severity_of(tone: Tone) -> Severity {
    match tone {
        Tone::Error => Severity::Error,
        Tone::Warning => Severity::Warning,
        Tone::Hint => Severity::Hint,
        _ => Severity::Information,
    }
}
